import pg from "pg";
import { notifyAlert } from "./notify.js";
import { processEscalations } from "./escalations.js";
import { evaluateExpression } from "./expressionEvaluator.js";

const { Pool } = pg;

const pool = new Pool({
  host: process.env.POSTGRES_HOST || "postgres",
  port: Number(process.env.POSTGRES_PORT) || 5432,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  max: 5
});

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS) || 30000;
const MIN_SAMPLES_REQUIRED = Number(process.env.MIN_SAMPLES_REQUIRED) || 2;

interface AlertRule {
  id: string;
  tenant_id: string;
  source_module: string;
  metric_name: string | null;
  condition: "gt" | "lt" | "eq" | null;
  threshold: number | null;
  duration_seconds: number;
  device_id: string | null;
  active: boolean;
  severity: string;
  recovery_threshold: number | null;
  expression_ast: any | null;
  display_expression: string | null;
}

function conditionBreached(value: number, condition: string, threshold: number): boolean {
  switch (condition) {
    case "gt":
      return value > threshold;
    case "lt":
      return value < threshold;
    case "eq":
      return value === threshold;
    default:
      return false;
  }
}

async function getActiveRules(): Promise<AlertRule[]> {
  const result = await pool.query(
    `SELECT id, tenant_id, source_module, metric_name, condition, threshold, duration_seconds, device_id, active, severity, recovery_threshold, expression_ast, display_expression
     FROM alert_rules WHERE active = true AND is_heartbeat = false`
  );
  return result.rows;
}

async function getDeviceIdsForRule(rule: AlertRule): Promise<string[]> {
  if (rule.device_id) return [rule.device_id];

  const result = await pool.query(
    `SELECT DISTINCT device_id FROM metrics
     WHERE tenant_id = $1 AND metric_name = $2
       AND time >= now() - ($3 || ' seconds')::interval`,
    [rule.tenant_id, rule.metric_name, rule.duration_seconds]
  );
  return result.rows.map((r) => r.device_id);
}

async function isInMaintenanceWindow(deviceId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM maintenance_windows mw
     WHERE mw.starts_at <= now() AND mw.ends_at >= now()
       AND (
         EXISTS (SELECT 1 FROM maintenance_window_devices mwd WHERE mwd.maintenance_window_id = mw.id AND mwd.device_id = $1)
         OR EXISTS (
           SELECT 1 FROM maintenance_window_groups mwg
           JOIN device_group_members dgm ON dgm.device_group_id = mwg.device_group_id
           WHERE mwg.maintenance_window_id = mw.id AND dgm.device_id = $1
         )
       )
     LIMIT 1`,
    [deviceId]
  );
  return result.rows.length > 0;
}

async function evaluateRuleForDevice(rule: AlertRule, deviceId: string) {
  // Cihaz aktif bir bakım penceresindeyse, kural hiç değerlendirilmez —
  // planlı bakım sırasında gürültü üretmemek için (Zabbix'teki "Maintenance" mantığı).
  if (await isInMaintenanceWindow(deviceId)) {
    return;
  }

  const result = await pool.query(
    `SELECT value, time FROM metrics
     WHERE tenant_id = $1 AND device_id = $2 AND metric_name = $3
       AND time >= now() - ($4 || ' seconds')::interval
     ORDER BY time ASC`,
    [rule.tenant_id, deviceId, rule.metric_name, rule.duration_seconds]
  );

  const rows = result.rows;

  // Yeterli örnek yoksa bu turu hiç değerlendirme — mevcut alarm durumuna dokunma.
  // Bu, "flapping" (yetersiz veri yüzünden yanlışlıkla açılıp kapanma) sorununu önler.
  if (rows.length < MIN_SAMPLES_REQUIRED) {
    return;
  }

  const allBreached = rows.every((r) => conditionBreached(Number(r.value), rule.condition, rule.threshold));

  // Histerezis (recovery_threshold): doluysa, "düzeldi" kontrolü orijinal eşik yerine
  // bu daha güvenli eşiğe göre yapılır — örn. threshold=90/recovery=80 ile alarm >90'da
  // açılır ama sadece <80 olunca kapanır, 80-90 arası gri bölgede flapping/gürültü olmaz
  // (Zabbix'in ayrı recovery_expression'ının karşılığı).
  const effectiveRecoveryThreshold = rule.recovery_threshold ?? rule.threshold;
  const stillInAlertZone = rows.every((r) => conditionBreached(Number(r.value), rule.condition, effectiveRecoveryThreshold));

  const existing = await pool.query(
    `SELECT id FROM alerts WHERE rule_id = $1 AND device_id = $2 AND resolved_at IS NULL`,
    [rule.id, deviceId]
  );
  const hasOpenAlert = existing.rows.length > 0;

  if (allBreached && !hasOpenAlert) {
    // Bağımlılık kontrolü: bu kural başka bir kurala bağımlıysa ve o kuralın
    // zaten açık bir alarmı varsa, yeni alarm ÜRETİLMEZ (alarm fırtınasını önler —
    // örn. cihaz tamamen erişilemezken "memory yüksek" gibi ikincil alarmlar bastırılır).
    const depsResult = await pool.query(
      `SELECT depends_on_rule_id FROM alert_rule_dependencies WHERE rule_id = $1`,
      [rule.id]
    );

    let suppressed = false;
    for (const dep of depsResult.rows) {
      const openDependency = await pool.query(
        `SELECT id FROM alerts WHERE rule_id = $1 AND device_id = $2 AND resolved_at IS NULL`,
        [dep.depends_on_rule_id, deviceId]
      );
      if (openDependency.rows.length > 0) {
        suppressed = true;
        break;
      }
    }

    const latestValue = rows[rows.length - 1].value;
    const message = `${rule.metric_name} eşiği aşıldı: değer=${latestValue}, koşul=${rule.condition} ${rule.threshold}, süre=${rule.duration_seconds}s`;

    if (suppressed) {
      const suppressingRuleId = depsResult.rows.find((d) => d)?.depends_on_rule_id;
      await pool.query(
        `INSERT INTO suppressed_alerts (tenant_id, rule_id, device_id, depends_on_rule_id, message)
         VALUES ($1, $2, $3, $4, $5)`,
        [rule.tenant_id, rule.id, deviceId, suppressingRuleId, message]
      );
      console.log(`[Alarm] BASTIRILDI (bağımlılık nedeniyle): rule=${rule.id} device=${deviceId} metric=${rule.metric_name}`);
      return;
    }

    // ON CONFLICT DO NOTHING: aynı (rule_id, device_id) için başka bir alarm-engine
    // döngüsü/kopyası zaten bir alarm açtıysa, ikinci satır sessizce atlanır —
    // ne duplike kayıt ne de duplike bildirim oluşur.
    const inserted = await pool.query(
      `INSERT INTO alerts (tenant_id, rule_id, device_id, severity, message, metric_name, condition, threshold, value)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (rule_id, device_id) WHERE resolved_at IS NULL DO NOTHING
       RETURNING id`,
      [rule.tenant_id, rule.id, deviceId, rule.severity || "warning", message, rule.metric_name, rule.condition, rule.threshold, latestValue]
    );

    if (inserted.rows.length === 0) {
      console.log(`[Alarm] Zaten açık (idempotent, atlandı): rule=${rule.id} device=${deviceId} metric=${rule.metric_name}`);
      return;
    }

    const alertId = inserted.rows[0].id;
    console.log(`[Alarm] YENİ ALARM: rule=${rule.id} device=${deviceId} metric=${rule.metric_name} value=${latestValue}`);

    const deviceResult = await pool.query(`SELECT name FROM devices WHERE id = $1`, [deviceId]);
    const deviceName = deviceResult.rows[0]?.name || "Bilinmeyen cihaz";
    await notifyAlert({
      alertId,
      tenantId: rule.tenant_id,
      deviceId,
      deviceName,
      severity: rule.severity || "warning",
      message
    });
  } else if (!stillInAlertZone && hasOpenAlert) {
    // WHERE id = $1 yerine rule_id+device_id ile eşleşen TÜM açık kayıtları kapatıyoruz —
    // geçmişte oluşmuş duplike açık alarmlar varsa bile hepsi doğru şekilde çözülür.
    const resolvedRows = await pool.query(
      `UPDATE alerts SET resolved_at = now() WHERE rule_id = $1 AND device_id = $2 AND resolved_at IS NULL RETURNING id`,
      [rule.id, deviceId]
    );
    console.log(`[Alarm] ÇÖZÜLDÜ: rule=${rule.id} device=${deviceId} metric=${rule.metric_name}`);
    // ÜRÜN/UX DÜZELTMESİ: önceden çözülme bildirimi hiç gönderilmiyordu.
    if (resolvedRows.rows.length > 0) {
      const deviceResult = await pool.query(`SELECT name FROM devices WHERE id = $1`, [deviceId]);
      const deviceName = deviceResult.rows[0]?.name || "Bilinmeyen cihaz";
      await notifyAlert({
        alertId: resolvedRows.rows[0].id,
        tenantId: rule.tenant_id,
        deviceId,
        deviceName,
        severity: rule.severity || "warning",
        message: `${rule.metric_name} eşiği artık aşılmıyor (koşul: ${rule.condition} ${rule.threshold})`,
        resolved: true
      });
    }
  }
}

// Nodata/Heartbeat izleme (kritik eksiklik duzeltmesi): npm-service bir cihazi SNMP'ye
// hic cevap vermedigi icin 'down' isaretledikten sonra, o cihaz icin degerlendirilecek
// YENI bir metrik degeri de gelmeyi kesiyor -- yani metrik-esigi bazli mevcut alarm
// mantigi bu durumu HIC yakalamiyordu (en kritik ariza senaryosu sessiz kaliyordu).
// Bu fonksiyon, 'down' durumdaki her cihaz icin otomatik bir "heartbeat" kurali/alarmi
// acar, cihaz tekrar 'active' olunca otomatik kapatir. rule_id her zaman GERCEK bir
// alert_rules satirina isaret eder (is_heartbeat=true ile ayirt edilir) -- boylece
// uq_alerts_open_rule_device unique index'i (NULL degerlerde calismaz) dogru calisir
// ve bildirim/eskalasyon/ustlenme gibi mevcut tum altyapi hic degismeden isler.
async function checkDeviceReachability() {
  const downDevices = await pool.query(`SELECT id, tenant_id, name FROM devices WHERE status = 'down'`);

  for (const device of downDevices.rows) {
    if (await isInMaintenanceWindow(device.id)) continue;

    const ruleResult = await pool.query(
      `SELECT id FROM alert_rules WHERE device_id = $1 AND is_heartbeat = true`,
      [device.id]
    );
    let ruleId: string;
    if (ruleResult.rows.length === 0) {
      const insertedRule = await pool.query(
        `INSERT INTO alert_rules (tenant_id, source_module, metric_name, condition, threshold, duration_seconds, device_id, severity, is_heartbeat)
         VALUES ($1, 'system', 'device_reachability', 'eq', 0, 0, $2, 'high', true)
         RETURNING id`,
        [device.tenant_id, device.id]
      );
      ruleId = insertedRule.rows[0].id;
    } else {
      ruleId = ruleResult.rows[0].id;
    }

    const message = `${device.name} cihazina ulasilamiyor (SNMP yanit vermiyor)`;
    const insertedAlert = await pool.query(
      `INSERT INTO alerts (tenant_id, rule_id, device_id, metric_name, condition, threshold, value, severity, message)
       VALUES ($1, $2, $3, 'device_reachability', 'eq', 0, 0, 'high', $4)
       ON CONFLICT (rule_id, device_id) WHERE resolved_at IS NULL DO NOTHING
       RETURNING id`,
      [device.tenant_id, ruleId, device.id, message]
    );

    if (insertedAlert.rows.length > 0) {
      console.log(`[Alarm] ${device.name} icin heartbeat (erisilemez) alarmi acildi`);
      await notifyAlert({
        alertId: insertedAlert.rows[0].id,
        tenantId: device.tenant_id,
        deviceId: device.id,
        deviceName: device.name,
        severity: "high",
        message
      });
    }
  }

  const resolved = await pool.query(
    `UPDATE alerts a SET resolved_at = now()
     FROM alert_rules r, devices d
     WHERE a.rule_id = r.id AND r.is_heartbeat = true AND a.device_id = d.id
       AND d.status = 'active' AND a.resolved_at IS NULL
     RETURNING a.id, a.tenant_id, a.device_id, d.name as device_name`
  );
  if (resolved.rows.length > 0) {
    console.log(`[Alarm] ${resolved.rows.length} heartbeat alarmi otomatik kapatildi (cihaz tekrar erisilebilir)`);
    // ÜRÜN/UX DÜZELTMESİ: önceden çözülme bildirimi hiç gönderilmiyordu.
    for (const row of resolved.rows) {
      await notifyAlert({
        alertId: row.id,
        tenantId: row.tenant_id,
        deviceId: row.device_id,
        deviceName: row.device_name || "Bilinmeyen cihaz",
        severity: "high",
        message: `${row.device_name} cihazina tekrar ulasilabiliyor`,
        resolved: true
      });
    }
  }
}
async function evaluateExpressionRuleForDevice(rule: AlertRule, deviceId: string) {
  if (await isInMaintenanceWindow(deviceId)) {
    return;
  }
  const problemState = await evaluateExpression(pool, rule.tenant_id, deviceId, rule.expression_ast);
  if (problemState === null) {
    return;
  }
  const existing = await pool.query(
    `SELECT id FROM alerts WHERE rule_id = $1 AND device_id = $2 AND resolved_at IS NULL`,
    [rule.id, deviceId]
  );
  const hasOpenAlert = existing.rows.length > 0;
  const message = rule.display_expression || "Cok-metrikli ifade kurali";
  if (problemState && !hasOpenAlert) {
    const inserted = await pool.query(
      `INSERT INTO alerts (tenant_id, rule_id, device_id, severity, message)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (rule_id, device_id) WHERE resolved_at IS NULL DO NOTHING
       RETURNING id`,
      [rule.tenant_id, rule.id, deviceId, rule.severity || "warning", message]
    );
    if (inserted.rows.length === 0) return;
    const alertId = inserted.rows[0].id;
    const deviceResult = await pool.query(`SELECT name FROM devices WHERE id = $1`, [deviceId]);
    const deviceName = deviceResult.rows[0]?.name || "Bilinmeyen cihaz";
    console.log(`[Alarm] YENİ ALARM (ifade): rule=${rule.id} device=${deviceId} expr="${message}"`);
    await notifyAlert({
      alertId, tenantId: rule.tenant_id, deviceId, deviceName,
      severity: rule.severity || "warning", message
    });
  } else if (!problemState && hasOpenAlert) {
    const resolvedRows = await pool.query(
      `UPDATE alerts SET resolved_at = now() WHERE rule_id = $1 AND device_id = $2 AND resolved_at IS NULL RETURNING id`,
      [rule.id, deviceId]
    );
    console.log(`[Alarm] ÇÖZÜLDÜ (ifade): rule=${rule.id} device=${deviceId} expr="${message}"`);
    if (resolvedRows.rows.length > 0) {
      const deviceResult = await pool.query(`SELECT name FROM devices WHERE id = $1`, [deviceId]);
      const deviceName = deviceResult.rows[0]?.name || "Bilinmeyen cihaz";
      await notifyAlert({
        alertId: resolvedRows.rows[0].id,
        tenantId: rule.tenant_id,
        deviceId,
        deviceName,
        severity: rule.severity || "warning",
        message,
        resolved: true
      });
    }
  }
}
async function evaluateAllRules() {
  const rules = await getActiveRules();
  console.log(`[Alarm] ${rules.length} aktif kural değerlendiriliyor...`);

  for (const rule of rules) {
    try {
      const deviceIds = await getDeviceIdsForRule(rule);
      for (const deviceId of deviceIds) {
        if (rule.expression_ast) {
          await evaluateExpressionRuleForDevice(rule, deviceId);
        } else {
          await evaluateRuleForDevice(rule, deviceId);
        }
      }
    } catch (err) {
      console.error(`[Alarm] Kural değerlendirme hatası (rule=${rule.id}):`, err);
    }
  }
}

// GERCEK EKSIKLIK DUZELTMESI: agent'lar PUSH modeliyle calisir (agent sunucuya
// baglanir, sunucu agent'a HIC baglanmaz) -- SNMP'nin aksine (npm-service aktif
// olarak cihaza gidip cevap gelmezse kendisi 'down' yazar), bir agent servisi
// COKERSE (Windows Service crash, guc kesintisi, ag kopmasi) HICBIR SEY bunu
// proaktif olarak fark etmiyordu. devices.status, SON basarili heartbeat'te ne
// yazildiysa SONSUZA DEK oyle kaliyordu -- checkDeviceReachability() 'status = down'
// diye sorgu attigi icin, o mekanizma da HIC tetiklenmiyordu (nodata alarmi hic
// acilmiyordu). Bu fonksiyon, heartbeat'i eskimis (stale) agent'lari bulup status'u
// 'down' yapar -- checkDeviceReachability() bir sonraki turunda bunu GORUP otomatik
// alarm acar, alarm mantigini burada TEKRARLAMAYA gerek yok. Heartbeat GERI GELDIGINDE
// tekrar 'active' yapmaya gerek yok -- /api/v1/agent/heartbeat endpoint'i zaten HER
// basarili cagrida status'u yeniden hesaplayip dogru degere getiriyor.
const AGENT_HEARTBEAT_STALE_SECONDS = 90; // agent'in varsayilan heartbeat'i 10sn -- 9 kati makul bir esik

async function checkAgentHeartbeats() {
  const staleDevices = await pool.query(
    `UPDATE devices SET status = 'down'
     WHERE agent_psk IS NOT NULL
       AND last_heartbeat_at IS NOT NULL
       AND last_heartbeat_at < now() - ($1 || ' seconds')::interval
       AND status != 'down'
     RETURNING id, name`,
    [AGENT_HEARTBEAT_STALE_SECONDS]
  );
  for (const device of staleDevices.rows) {
    console.log(`[Alarm] ${device.name}: agent heartbeat'i eskimiş (>${AGENT_HEARTBEAT_STALE_SECONDS}sn), 'down' olarak işaretlendi`);
  }

  // device_collector_status'taki 'agent' kaydini da guncelle -- dashboard'daki diger
  // gostergeler (orn. Host Kullanilabilirligi widget'i) bu tabloyu da okuyor olabilir.
  await pool.query(
    `UPDATE device_collector_status dcs SET status = 'down', last_checked_at = now()
     FROM devices d
     WHERE dcs.device_id = d.id AND dcs.collector_type = 'agent'
       AND d.agent_psk IS NOT NULL AND d.last_heartbeat_at IS NOT NULL
       AND d.last_heartbeat_at < now() - ($1 || ' seconds')::interval
       AND dcs.status != 'down'`,
    [AGENT_HEARTBEAT_STALE_SECONDS]
  );
}

async function main() {
  console.log("[Alarm] Alarm motoru başlıyor...");
  await evaluateAllRules();
  await checkDeviceReachability();
  await checkAgentHeartbeats();
  setInterval(evaluateAllRules, CHECK_INTERVAL_MS);
  setInterval(() => processEscalations(pool), CHECK_INTERVAL_MS);
  setInterval(checkDeviceReachability, CHECK_INTERVAL_MS);
  setInterval(checkAgentHeartbeats, CHECK_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[Alarm] Başlatma hatası:", err);
  process.exit(1);
});
