import pg from "pg";
import { notifyAlert } from "./notify.js";

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
  metric_name: string;
  condition: "gt" | "lt" | "eq";
  threshold: number;
  duration_seconds: number;
  device_id: string | null;
  active: boolean;
  severity: string;
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
    `SELECT id, tenant_id, source_module, metric_name, condition, threshold, duration_seconds, device_id, active, severity
     FROM alert_rules WHERE active = true`
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

    await pool.query(
      `INSERT INTO alerts (tenant_id, rule_id, device_id, severity, message)
       VALUES ($1, $2, $3, $4, $5)`,
      [rule.tenant_id, rule.id, deviceId, rule.severity || "warning", message]
    );
    console.log(`[Alarm] YENİ ALARM: rule=${rule.id} device=${deviceId} metric=${rule.metric_name} value=${latestValue}`);

    const deviceResult = await pool.query(`SELECT name FROM devices WHERE id = $1`, [deviceId]);
    const deviceName = deviceResult.rows[0]?.name || "Bilinmeyen cihaz";
    await notifyAlert({
      tenantId: rule.tenant_id,
      deviceId,
      deviceName,
      severity: rule.severity || "warning",
      message
    });
  } else if (!allBreached && hasOpenAlert) {
    await pool.query(
      `UPDATE alerts SET resolved_at = now() WHERE id = $1`,
      [existing.rows[0].id]
    );
    console.log(`[Alarm] ÇÖZÜLDÜ: rule=${rule.id} device=${deviceId} metric=${rule.metric_name}`);
  }
}

async function evaluateAllRules() {
  const rules = await getActiveRules();
  console.log(`[Alarm] ${rules.length} aktif kural değerlendiriliyor...`);

  for (const rule of rules) {
    try {
      const deviceIds = await getDeviceIdsForRule(rule);
      for (const deviceId of deviceIds) {
        await evaluateRuleForDevice(rule, deviceId);
      }
    } catch (err) {
      console.error(`[Alarm] Kural değerlendirme hatası (rule=${rule.id}):`, err);
    }
  }
}

async function main() {
  console.log("[Alarm] Alarm motoru başlıyor...");
  await evaluateAllRules();
  setInterval(evaluateAllRules, CHECK_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[Alarm] Başlatma hatası:", err);
  process.exit(1);
});
