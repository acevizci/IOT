import pg from "pg";
import http from "http";
import { notifyAlert, retryFailedDeliveries } from "./notify.js";
import { processEscalations } from "./escalations.js";
import { checkRootCauseAndCreateIncident, reconcileIncidents } from "./incidentEngine.js";
import { evaluateExpression } from "./expressionEvaluator.js";
import { checkAnomaliesForRule } from "./anomalyDetection.js";
import { checkPredictionsForRule } from "./predictiveAnalytics.js";
import { materializeApmMetrics } from "./apmMetrics.js";

const { Pool } = pg;

const pool = new Pool({
  host: process.env.POSTGRES_HOST || "postgres",
  port: Number(process.env.POSTGRES_PORT) || 5432,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  max: 5
});

const HTTP_PORT = Number(process.env.HTTP_PORT) || 3500;
// GÜVENİLİRLİK: sadece "process ayakta mı" değil, "değerlendirme döngüsü GERÇEKTEN
// çalışıyor mu" diye kontrol eden bir health check -- evaluateAllRules (en kritik
// periyodik görev) her turun başında bu zamanı güncelliyor.
let lastEvaluationTickAt = Date.now();

function startHealthServer() {
  http.createServer((req, res) => {
    if (req.url === "/health") {
      const staleMs = Date.now() - lastEvaluationTickAt;
      const healthy = staleMs < CHECK_INTERVAL_MS * 3;
      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: healthy ? "ok" : "stale", service: "alarm-engine", last_tick_ms_ago: staleMs }));
    } else {
      res.writeHead(404);
      res.end();
    }
  }).listen(HTTP_PORT, () => console.log(`[Alarm] Health check HTTP: ${HTTP_PORT}`));
}

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS) || 30000;
const APM_MATERIALIZE_INTERVAL_MS = Number(process.env.APM_MATERIALIZE_INTERVAL_MS) || 60000;
const MIN_SAMPLES_REQUIRED = Number(process.env.MIN_SAMPLES_REQUIRED) || 2;
// KAPSAM GENİŞLETMESİ (bkz. DENETIM_RAPORU.md §4): bir metrik ne kadar süre hiç
// rapor edilmezse "nodata" sayılsın. duration_seconds'ın katı olarak tanımlanıyor ki
// kısa süreli/geçici boşluklarda (tek bir kaçırılmış polling turu gibi) yanlışlıkla
// tetiklenmesin -- sadece GERÇEKTEN uzun süreli bir kesinti nodata alarmı üretsin.
const NODATA_GRACE_MULTIPLIER = Number(process.env.NODATA_GRACE_MULTIPLIER) || 3;
// GERÇEK EKSİKLİK (alarm sistemi incelemesi): nodata kontrolü önceden SADECE
// cihaz-seviyesindeydi (duration_seconds gibi KISA bir pencerede TÜM instance'ların
// toplam satır sayısına bakıyordu) -- çok-instance'lı bir metrikte (örn. 5 interface)
// sadece BİRİ raporlamayı kesse bile diğerleri veri gönderdiği sürece bu sessizce
// kaçırılıyordu. Artık her instance ayrı değerlendiriliyor, ama "hangi instance'lar
// var" sorusuna duration_seconds gibi kısa bir pencere cevap veremez (bkz.
// checkNodataForRule) -- bunun için çok daha uzun bir "keşif" penceresi kullanılıyor.
const NODATA_INSTANCE_LOOKBACK_HOURS = Number(process.env.NODATA_INSTANCE_LOOKBACK_HOURS) || 24;

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
  // FAZ J.0: hangi kolona göre (interface/instance_label) instance-bazlı gruplanacağını
  // seçer. NULL = eski davranış (tüm satırlar tek grup, cihaz-seviyesi tek alarm).
  instance_tag_key: "interface" | "instance_label" | null;
  // Anomali Tespiti opt-out (Datadog'un monitör-bazlı mute deseniyle AYNI mantık).
  anomaly_enabled: boolean;
  // Anomali Tespiti: kural-bazlı sigma override (null = global ANOMALY_SIGMA)
  // ve opt-in saatlik mevsimsel baseline.
  anomaly_sigma: number | null;
  anomaly_seasonal: boolean;
  // Predictive Analytics opt-out + kural başına yapılandırılabilir tahmin ufku.
  predictive_enabled: boolean;
  predictive_horizon_hours: number;
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
  // Anomali Tespiti: is_anomaly=true olan satırlar "gölge" kurallardır
  // (checkDeviceReachability'nin heartbeat deseniyle AYNI mantık) -- kendi
  // condition='anomaly' değeri normal conditionBreached() mantığıyla
  // UYUMSUZ olduğu için, bu satırların normal değerlendirme akışına HİÇ
  // girmemesi gerekir (anomalyDetection.ts ayrı bir yoldan işler).
  const result = await pool.query(
    `SELECT id, tenant_id, source_module, metric_name, condition, threshold, duration_seconds, device_id, active, severity, recovery_threshold, expression_ast, display_expression, instance_tag_key, anomaly_enabled, anomaly_sigma, anomaly_seasonal, predictive_enabled, predictive_horizon_hours
     FROM alert_rules WHERE active = true AND is_heartbeat = false AND is_anomaly = false AND is_predictive = false`
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

// KAPSAM GENİŞLETMESİ (bkz. DENETIM_RAPORU.md §4): bir metrik uzun süredir hiç
// raporlanmıyorsa (cihaz genel olarak erişilebilir olsa bile) bunu ayrı bir
// "nodata" alarmı olarak işaretler. Sadece device_id'ye bağlı (cihaza özel)
// kurallar için anlamlı -- device_id NULL olan (tenant genelinde metrik adına göre
// çalışan) kurallarda "hangi cihaz raporlamıyor" belirsiz olduğu için kapsam dışı
// bırakıldı (getDeviceIdsForRule zaten böyle kurallar için sadece VERİSİ OLAN
// cihazları döner, dolayısıyla bu fonksiyon onlar için hiç çağrılmaz).
//
// GERÇEK EKSİKLİK DÜZELTMESİ: presentInstances parametresi eklendi -- artık
// SADECE "hiçbir instance hiç veri göndermiyor" durumunda değil, "önceden veri
// gönderen bir instance artık göndermiyor" durumunda da (diğer instance'lar
// sağlıklı olsa bile) devreye giriyor. duration_seconds gibi kısa bir pencere
// "hangi instance'lar var" sorusuna cevap veremeyeceği için (raporlamayı yeni
// kesmiş bir instance o pencerede zaten hiç görünmez), çok daha uzun bir keşif
// penceresi (NODATA_INSTANCE_LOOKBACK_HOURS) kullanılıyor.
async function checkNodataForRule(rule: AlertRule, deviceId: string, presentInstances: Set<string>) {
  if (!rule.device_id) return;

  const deviceResult = await pool.query(`SELECT status, name FROM devices WHERE id = $1`, [deviceId]);
  if (deviceResult.rows.length === 0 || deviceResult.rows[0].status !== "active") return;
  // Cihaz zaten 'down' ise reachability/heartbeat alarmı bunu çoktan yakalamıştır --
  // aynı kesinti için ikinci bir (yanıltıcı, "sadece bu metrik" izlenimi veren) alarm
  // üretmeye gerek yok.

  const instanceColumn = rule.instance_tag_key === "interface" ? "interface"
    : rule.instance_tag_key === "instance_label" ? "instance_label"
    : null;
  const graceSeconds = rule.duration_seconds * NODATA_GRACE_MULTIPLIER;

  const knownResult = instanceColumn
    ? await pool.query(
        `SELECT COALESCE(${instanceColumn}, '') as instance_value, MAX(time) as last_seen
         FROM metrics WHERE tenant_id = $1 AND device_id = $2 AND metric_name = $3
           AND time >= now() - INTERVAL '${NODATA_INSTANCE_LOOKBACK_HOURS} hours'
         GROUP BY COALESCE(${instanceColumn}, '')`,
        [rule.tenant_id, deviceId, rule.metric_name]
      )
    : await pool.query(
        `SELECT '' as instance_value, MAX(time) as last_seen
         FROM metrics WHERE tenant_id = $1 AND device_id = $2 AND metric_name = $3
           AND time >= now() - INTERVAL '${NODATA_INSTANCE_LOOKBACK_HOURS} hours'`,
        [rule.tenant_id, deviceId, rule.metric_name]
      );

  for (const row of knownResult.rows) {
    const instanceValue: string = row.instance_value;
    if (presentInstances.has(instanceValue)) continue; // hâlâ raporluyor, sorun yok

    const lastSeenAt: Date | null = row.last_seen;
    const staleSeconds = lastSeenAt ? (Date.now() - new Date(lastSeenAt).getTime()) / 1000 : Infinity;
    if (staleSeconds < graceSeconds) continue; // henüz grace period içinde -- geçici/kısa boşluk olabilir, sessizce bekle

    const existing = await pool.query(
      `SELECT id FROM alerts WHERE rule_id = $1 AND device_id = $2 AND instance_tag_value = $3 AND resolved_at IS NULL`,
      [rule.id, deviceId, instanceValue]
    );
    if (existing.rows.length > 0) continue; // zaten açık bir alarm var (eşik ya da nodata), tekrar açma

    const instanceLabel = instanceValue ? ` [${instanceValue}]` : "";
    const staleDisplay = Number.isFinite(staleSeconds) ? `${Math.round(staleSeconds)} saniyedir` : "hiç";
    const message = `${rule.metric_name}${instanceLabel} için ${staleDisplay} veri gelmiyor (cihaz erişilebilir görünüyor)`;
    const inserted = await pool.query(
      `INSERT INTO alerts (tenant_id, rule_id, device_id, instance_tag_value, severity, message, metric_name, is_nodata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       ON CONFLICT (rule_id, device_id, instance_tag_value) WHERE resolved_at IS NULL DO NOTHING
       RETURNING id`,
      [rule.tenant_id, rule.id, deviceId, instanceValue, rule.severity || "warning", message, rule.metric_name]
    );
    if (inserted.rows.length === 0) continue;

    console.log(`[Alarm] NODATA: rule=${rule.id} device=${deviceId} metric=${rule.metric_name}${instanceLabel} (${staleDisplay} veri yok)`);
    await notifyAlert({
      alertId: inserted.rows[0].id,
      tenantId: rule.tenant_id,
      deviceId,
      deviceName: deviceResult.rows[0].name || "Bilinmeyen cihaz",
      severity: rule.severity || "warning",
      message
    });
    checkRootCauseAndCreateIncident(rule.tenant_id, deviceId, inserted.rows[0].id);
  }
}

// Veri tekrar gelmeye başladığında, o instance için açık bir nodata alarmı varsa
// kapatır -- aynı rule_id+device_id+instance_tag_value slotunu eşik alarmının
// kullanabilmesi için (UNIQUE constraint aynı anda tek açık alarma izin verir).
// GERÇEK EKSİKLİK DÜZELTMESİ: önceden instance_tag_value FİLTRESİ YOKTU -- bir
// instance geri geldiğinde AYNI rule_id+device_id altındaki TÜM nodata alarmları
// (başka, hâlâ sessiz kalan instance'lar dahil) yanlışlıkla kapatılabiliyordu.
async function resolveNodataIfPresent(rule: AlertRule, deviceId: string, presentInstances: Set<string>) {
  if (presentInstances.size === 0) return;
  const resolvedRows = await pool.query(
    `UPDATE alerts SET resolved_at = now()
     WHERE rule_id = $1 AND device_id = $2 AND resolved_at IS NULL AND is_nodata = true
       AND instance_tag_value = ANY($3)
     RETURNING id, instance_tag_value`,
    [rule.id, deviceId, Array.from(presentInstances)]
  );
  if (resolvedRows.rows.length === 0) return;
  const deviceResult = await pool.query(`SELECT name FROM devices WHERE id = $1`, [deviceId]);
  for (const row of resolvedRows.rows) {
    const instanceLabel = row.instance_tag_value ? ` [${row.instance_tag_value}]` : "";
    console.log(`[Alarm] NODATA ÇÖZÜLDÜ (veri tekrar gelmeye başladı): rule=${rule.id} device=${deviceId} metric=${rule.metric_name}${instanceLabel}`);
    await notifyAlert({
      alertId: row.id,
      tenantId: rule.tenant_id,
      deviceId,
      deviceName: deviceResult.rows[0]?.name || "Bilinmeyen cihaz",
      severity: rule.severity || "warning",
      message: `${rule.metric_name}${instanceLabel} için veri akışı tekrar başladı`,
      resolved: true
    });
  }
}

async function evaluateRuleForDevice(rule: AlertRule, deviceId: string) {
  // Cihaz aktif bir bakım penceresindeyse, kural hiç değerlendirilmez —
  // planlı bakım sırasında gürültü üretmemek için (Zabbix'teki "Maintenance" mantığı).
  if (await isInMaintenanceWindow(deviceId)) {
    return;
  }

  const result = await pool.query(
    `SELECT value, time, interface, instance_label FROM metrics
     WHERE tenant_id = $1 AND device_id = $2 AND metric_name = $3
       AND time >= now() - ($4 || ' seconds')::interval
     ORDER BY time ASC`,
    [rule.tenant_id, deviceId, rule.metric_name, rule.duration_seconds]
  );

  const rows = result.rows;

  // FAZ J.0 (mantık hatası düzeltmesi): önceden TÜM satırlar (farklı interface'ler/
  // instance'lar dahil) karıştırılıp rows.every() ile TEK blok değerlendiriliyordu --
  // çok-instance'lı bir metrikte (örn. 5 interface'ten sadece 1'i hatalıyken) diğer 4
  // interface'in temiz satırları .every()'i başarısız kılıp alarmın HİÇ tetiklenmemesine
  // yol açabiliyordu. instance_tag_key NULL ise davranış BİREBİR eskisiyle aynı (tüm
  // satırlar tek grup '', sıfır regresyon) -- 'interface'/'instance_label' seçiliyse
  // satırlar o kolona göre ayrı ayrı gruplanıp HER GRUP kendi başına değerlendirilir.
  const instanceKey = rule.instance_tag_key;
  const groups = new Map<string, { value: number; time: Date }[]>();
  for (const row of rows) {
    const key = instanceKey === "interface" ? (row.interface ?? "")
              : instanceKey === "instance_label" ? (row.instance_label ?? "")
              : "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ value: Number(row.value), time: row.time });
  }

  // GERÇEK EKSİKLİK DÜZELTMESİ (alarm sistemi incelemesi): önceden nodata kontrolü
  // SADECE tüm instance'ların toplam satır sayısı MIN_SAMPLES_REQUIRED'ın altındaysa
  // çalışıyordu -- çok-instance'lı bir metrikte SADECE BİR instance raporlamayı
  // kesse bile (diğerleri sağlıklı raporlamaya devam ettiği sürece) toplam sayı
  // yeterli kalıyordu, o instance için NE threshold değerlendirmesi (grubu hiç yok)
  // NE DE nodata alarmı (cihaz-seviyesi kontrol geçiyor) tetiklenmiyordu -- sessiz
  // bir kör nokta. Artık her turda, "şu an veri gelen instance'lar" (presentInstances)
  // ile "daha önce veri göndermiş ama şimdi göndermeyen instance'lar" ayrı ayrı
  // kontrol ediliyor.
  const presentInstances = new Set(groups.keys());
  await checkNodataForRule(rule, deviceId, presentInstances);
  await resolveNodataIfPresent(rule, deviceId, presentInstances);

  for (const [instanceValue, groupRows] of groups) {
    // Yeterli örnek yoksa bu instance'ı bu tur hiç değerlendirme — mevcut alarm
    // durumuna dokunma ("flapping" önleme). Önceden cihaz-seviyesindeydi (TÜM
    // instance'ların toplamına bakılıyordu), artık her instance kendi başına.
    if (groupRows.length < MIN_SAMPLES_REQUIRED) continue;
    await evaluateGroupForRule(rule, deviceId, instanceValue, groupRows);
  }
}

// Eski evaluateRuleForDevice gövdesinin (allBreached/hasOpenAlert/bağımlılık kontrolü/
// INSERT/UPDATE/notifyAlert) BİREBİR AYNISI -- tek fark: her sorguya instance_tag_value
// eklendi (existing-alert sorgusu, INSERT sütun listesi, UPDATE WHERE koşulu) ve mesaj
// metnine instance etiketi eklendi.
async function evaluateGroupForRule(
  rule: AlertRule, deviceId: string, instanceValue: string,
  rows: { value: number; time: Date }[]
) {
  const allBreached = rows.every((r) => conditionBreached(r.value, rule.condition!, rule.threshold!));

  // Histerezis (recovery_threshold): doluysa, "düzeldi" kontrolü orijinal eşik yerine
  // bu daha güvenli eşiğe göre yapılır — örn. threshold=90/recovery=80 ile alarm >90'da
  // açılır ama sadece <80 olunca kapanır, 80-90 arası gri bölgede flapping/gürültü olmaz
  // (Zabbix'in ayrı recovery_expression'ının karşılığı).
  const effectiveRecoveryThreshold = rule.recovery_threshold ?? rule.threshold!;
  const stillInAlertZone = rows.every((r) => conditionBreached(r.value, rule.condition!, effectiveRecoveryThreshold));

  const existing = await pool.query(
    `SELECT id FROM alerts WHERE rule_id = $1 AND device_id = $2 AND instance_tag_value = $3 AND resolved_at IS NULL`,
    [rule.id, deviceId, instanceValue]
  );
  const hasOpenAlert = existing.rows.length > 0;
  const instanceLabel = instanceValue ? ` [${instanceValue}]` : "";

  if (allBreached && !hasOpenAlert) {
    // Bağımlılık kontrolü: bu kural başka bir kurala bağımlıysa ve o kuralın
    // zaten açık bir alarmı varsa, yeni alarm ÜRETİLMEZ (alarm fırtınasını önler —
    // örn. cihaz tamamen erişilemezken "memory yüksek" gibi ikincil alarmlar bastırılır).
    // NOT: bağımlılık kontrolü BİLİNÇLİ OLARAK cihaz-seviyesinde kalıyor (instance_tag_value
    // eşleşmesi ARANMIYOR) -- örn. "cihaz erişilemez" (cihaz-seviyesi, instance_tag_value='')
    // bir kural, "interface X down" (instance-seviyesi) bir kuralı bastırabilmeli; bunların
    // instance_tag_value'sunun eşleşmesini beklemek yanlış olurdu.
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
    const message = `${rule.metric_name}${instanceLabel} eşiği aşıldı: değer=${latestValue}, koşul=${rule.condition} ${rule.threshold}, süre=${rule.duration_seconds}s`;

    if (suppressed) {
      const suppressingRuleId = depsResult.rows.find((d) => d)?.depends_on_rule_id;
      await pool.query(
        `INSERT INTO suppressed_alerts (tenant_id, rule_id, device_id, depends_on_rule_id, message)
         VALUES ($1, $2, $3, $4, $5)`,
        [rule.tenant_id, rule.id, deviceId, suppressingRuleId, message]
      );
      console.log(`[Alarm] BASTIRILDI (bağımlılık nedeniyle): rule=${rule.id} device=${deviceId} metric=${rule.metric_name}${instanceLabel}`);
      return;
    }

    // ON CONFLICT DO NOTHING: aynı (rule_id, device_id, instance_tag_value) için başka
    // bir alarm-engine döngüsü/kopyası zaten bir alarm açtıysa, ikinci satır sessizce
    // atlanır — ne duplike kayıt ne de duplike bildirim oluşur.
    const inserted = await pool.query(
      `INSERT INTO alerts (tenant_id, rule_id, device_id, instance_tag_value, severity, message, metric_name, condition, threshold, value)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (rule_id, device_id, instance_tag_value) WHERE resolved_at IS NULL DO NOTHING
       RETURNING id`,
      [rule.tenant_id, rule.id, deviceId, instanceValue, rule.severity || "warning", message, rule.metric_name, rule.condition, rule.threshold, latestValue]
    );

    if (inserted.rows.length === 0) {
      console.log(`[Alarm] Zaten açık (idempotent, atlandı): rule=${rule.id} device=${deviceId} metric=${rule.metric_name}${instanceLabel}`);
      return;
    }

    const alertId = inserted.rows[0].id;
    console.log(`[Alarm] YENİ ALARM: rule=${rule.id} device=${deviceId} metric=${rule.metric_name}${instanceLabel} value=${latestValue}`);

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
    checkRootCauseAndCreateIncident(rule.tenant_id, deviceId, alertId);
  } else if (!stillInAlertZone && hasOpenAlert) {
    // WHERE id = $1 yerine rule_id+device_id+instance_tag_value ile eşleşen TÜM açık
    // kayıtları kapatıyoruz — geçmişte oluşmuş duplike açık alarmlar varsa bile hepsi
    // doğru şekilde çözülür.
    const resolvedRows = await pool.query(
      `UPDATE alerts SET resolved_at = now() WHERE rule_id = $1 AND device_id = $2 AND instance_tag_value = $3 AND resolved_at IS NULL RETURNING id`,
      [rule.id, deviceId, instanceValue]
    );
    console.log(`[Alarm] ÇÖZÜLDÜ: rule=${rule.id} device=${deviceId} metric=${rule.metric_name}${instanceLabel}`);
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
        message: `${rule.metric_name}${instanceLabel} eşiği artık aşılmıyor (koşul: ${rule.condition} ${rule.threshold})`,
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
       ON CONFLICT (rule_id, device_id, instance_tag_value) WHERE resolved_at IS NULL DO NOTHING
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
      checkRootCauseAndCreateIncident(device.tenant_id, device.id, insertedAlert.rows[0].id);
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
       ON CONFLICT (rule_id, device_id, instance_tag_value) WHERE resolved_at IS NULL DO NOTHING
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
    checkRootCauseAndCreateIncident(rule.tenant_id, deviceId, alertId);
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
  lastEvaluationTickAt = Date.now();
  let rules: AlertRule[];
  try {
    rules = await getActiveRules();
  } catch (err) {
    // GÜVENİLİRLİK DÜZELTMESİ: bu sorgu (örn. Postgres'e geçici bir bağlantı
    // sorunu yüzünden) hata fırlatırsa, önceden bu fonksiyon setInterval ile
    // çağrıldığı için (hiçbir .catch() eklenmemiş) YAKALANMAMIŞ bir promise
    // reddi oluşuyordu -- Node.js'in varsayılan davranışı bu durumda TÜM
    // PROCESS'İ SONLANDIRIR (alarm motoru tamamen çöker, Docker'ın yeniden
    // başlatması birkaç saniye sürer, bu arada hiçbir alarm değerlendirilmez).
    console.error("[Alarm] Aktif kurallar çekilemedi (bu tur atlanıyor):", err);
    return;
  }
  console.log(`[Alarm] ${rules.length} aktif kural değerlendiriliyor...`);

  // GERÇEK HATA (canlı testte bulundu): shouldRunAnomalyCheckThisTick()'in yan
  // etkisi var (çağrıldığında lastAnomalyCheckAt'i günceller). Bunu döngünün
  // İÇİNDE her kural için çağırmak, turdaki İLK uygun kuralın throttle'ı hemen
  // "kullanmasına" ve aynı turdaki TÜM SONRAKİ kuralların sessizce atlanmasına
  // yol açıyordu (her turda sadece 1 kural için anomali kontrolü çalışıyordu).
  // Düzeltme: throttle kararı döngü BAŞLAMADAN ÖNCE, tur başına BİR KEZ alınıyor.
  const runAnomalyChecksThisTick = shouldRunAnomalyCheckThisTick();

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
      // Anomali Tespiti: sadece basit metric+condition kurallarında anlamlı
      // (expression kurallarının TEK bir metric_name'i yok, hangi metriğin baseline'ı
      // alınacağı belirsiz olurdu).
      if (!rule.expression_ast && rule.metric_name && rule.anomaly_enabled && runAnomalyChecksThisTick) {
        await checkAnomaliesForRule(pool, {
          id: rule.id, tenant_id: rule.tenant_id, metric_name: rule.metric_name,
          device_id: rule.device_id, duration_seconds: rule.duration_seconds,
          severity: rule.severity, instance_tag_key: rule.instance_tag_key,
          anomaly_sigma: rule.anomaly_sigma, anomaly_seasonal: rule.anomaly_seasonal
        }, deviceIds);
      }
      // Predictive Analytics: anomali kontrolüyle AYNI throttle turu paylaşılıyor
      // (ikisi de "ağır" işlemler, aynı seyrek sıklıkta çalışmaları mantıklı).
      if (!rule.expression_ast && rule.metric_name && rule.predictive_enabled && runAnomalyChecksThisTick) {
        await checkPredictionsForRule(pool, {
          id: rule.id, tenant_id: rule.tenant_id, metric_name: rule.metric_name,
          device_id: rule.device_id, condition: rule.condition, threshold: rule.threshold,
          severity: rule.severity, instance_tag_key: rule.instance_tag_key,
          predictive_horizon_hours: rule.predictive_horizon_hours
        }, deviceIds);
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
// GERÇEK EKSİKLİK DÜZELTMESİ (alarm sistemi incelemesi): önceden TÜM agent'lar
// için TEK bir sabit (90sn = varsayılan 10sn heartbeat'in 9 katı) kullanılıyordu.
// Ama services/agent/config.go'daki HeartbeatSeconds her agent için ayrı
// yapılandırılabilir (örn. düşük bant genişlikli uzak bir site için 60sn/120sn
// makul olabilir) -- sabit 90sn eşiği, 60sn+ yapılandırılmış her agent'ta düzenli
// yanlış-pozitif "erişilemez" alarmına (flapping), çok kısa yapılandırılmışlarda
// ise gereğinden yavaş tespite yol açıyordu. Artık her cihazın kendi bildirdiği
// agent_heartbeat_seconds (bkz. /api/v1/agent/heartbeat, migration 099) çarpı bu
// oran kullanılıyor -- varsayılan oran (9), eski sabit davranışı (10sn * 9 = 90sn)
// hiç göndermemiş/eski agent binary'leri için AYNEN korur.
const AGENT_HEARTBEAT_GRACE_MULTIPLIER = Number(process.env.AGENT_HEARTBEAT_GRACE_MULTIPLIER) || 9;

async function checkAgentHeartbeats() {
  const staleDevices = await pool.query(
    `UPDATE devices SET status = 'down'
     WHERE agent_psk IS NOT NULL
       AND last_heartbeat_at IS NOT NULL
       AND last_heartbeat_at < now() - ((agent_heartbeat_seconds * $1) || ' seconds')::interval
       AND status != 'down'
     RETURNING id, name, agent_heartbeat_seconds`,
    [AGENT_HEARTBEAT_GRACE_MULTIPLIER]
  );
  for (const device of staleDevices.rows) {
    const staleThreshold = device.agent_heartbeat_seconds * AGENT_HEARTBEAT_GRACE_MULTIPLIER;
    console.log(`[Alarm] ${device.name}: agent heartbeat'i eskimiş (>${staleThreshold}sn, kendi aralığı=${device.agent_heartbeat_seconds}sn), 'down' olarak işaretlendi`);
  }

  // device_collector_status'taki 'agent' kaydini da guncelle -- dashboard'daki diger
  // gostergeler (orn. Host Kullanilabilirligi widget'i) bu tabloyu da okuyor olabilir.
  // Eşik, ilk sorgudaki AYNI mantıkla (per-device agent_heartbeat_seconds * oran) hesaplanıyor.
  await pool.query(
    `UPDATE device_collector_status dcs SET status = 'down', last_checked_at = now()
     FROM devices d
     WHERE dcs.device_id = d.id AND dcs.collector_type = 'agent'
       AND d.agent_psk IS NOT NULL AND d.last_heartbeat_at IS NOT NULL
       AND d.last_heartbeat_at < now() - ((d.agent_heartbeat_seconds * $1) || ' seconds')::interval
       AND dcs.status != 'down'`,
    [AGENT_HEARTBEAT_GRACE_MULTIPLIER]
  );
}

// GÜVENİLİRLİK DÜZELTMESİ: setInterval ile çağrılan async fonksiyonlardan biri
// (checkDeviceReachability, checkAgentHeartbeats, processEscalations) hata
// fırlatırsa, hiçbir .catch() eklenmediği için bu YAKALANMAMIŞ bir promise reddi
// oluşturuyordu -- Node.js'in varsayılan davranışı (v15+) bu durumda TÜM
// PROCESS'İ SONLANDIRIR. Bu sarmalayıcı, periyodik görevlerden birindeki geçici
// bir hatanın (örn. Postgres'e kısa süreli bağlantı sorunu) tüm alarm motorunu
// çökertmesini önler -- sadece o turu loglayıp bir sonraki turda devam eder.
function safeRun(fn: () => Promise<void>, label: string): () => void {
  return () => {
    fn().catch((err) => {
      console.error(`[Alarm] ${label} sırasında yakalanmamış hata (bir sonraki tur devam edecek):`, err);
    });
  };
}

// Anomali Tespiti: baseline hesaplama (24 saatlik agregasyon sorgusu) normal
// eşik değerlendirmesinden ÇOK daha ağır bir işlem -- her 30 saniyelik ana
// döngü turunda çalıştırmak yerine, ayrı ve daha seyrek bir aralıkla (varsayılan
// 5dk) throttle ediyoruz. Tüm kurallar AYNI tur içinde bu throttle'ı paylaşır
// (ya hepsi o turda çalışır ya hiçbiri) -- basit ve yeterli.
const ANOMALY_CHECK_INTERVAL_MS = Number(process.env.ANOMALY_CHECK_INTERVAL_MS) || 5 * 60 * 1000;
let lastAnomalyCheckAt = 0;
function shouldRunAnomalyCheckThisTick(): boolean {
  const now = Date.now();
  if (now - lastAnomalyCheckAt >= ANOMALY_CHECK_INTERVAL_MS) {
    lastAnomalyCheckAt = now;
    return true;
  }
  return false;
}

async function main() {
  console.log("[Alarm] Alarm motoru başlıyor...");
  startHealthServer();
  const safeEvaluateAllRules = safeRun(evaluateAllRules, "evaluateAllRules");
  const safeCheckDeviceReachability = safeRun(checkDeviceReachability, "checkDeviceReachability");
  const safeCheckAgentHeartbeats = safeRun(checkAgentHeartbeats, "checkAgentHeartbeats");
  const safeProcessEscalations = safeRun(() => processEscalations(pool), "processEscalations");
  const safeRetryFailedDeliveries = safeRun(retryFailedDeliveries, "retryFailedDeliveries");
  const safeReconcileIncidents = safeRun(() => reconcileIncidents(pool), "reconcileIncidents");
  // APM/Anomali inceleme: RED metriklerini ClickHouse'tan Postgres metrics'e
  // materialize eder (bkz. apmMetrics.ts) -- Agent'ın gerçek push aralığıyla
  // AYNI büyüklük mertebesinde (60sn), her CHECK_INTERVAL_MS turunda değil.
  const safeMaterializeApmMetrics = safeRun(() => materializeApmMetrics(pool), "materializeApmMetrics");

  safeEvaluateAllRules();
  safeCheckDeviceReachability();
  safeCheckAgentHeartbeats();

  setInterval(safeEvaluateAllRules, CHECK_INTERVAL_MS);
  setInterval(safeProcessEscalations, CHECK_INTERVAL_MS);
  setInterval(safeCheckDeviceReachability, CHECK_INTERVAL_MS);
  setInterval(safeCheckAgentHeartbeats, CHECK_INTERVAL_MS);
  // GÜVENİLİRLİK DÜZELTMESİ: daha önce başarısız olmuş bildirimleri periyodik
  // olarak yeniden dener (bkz. notify.ts retryFailedDeliveries).
  setInterval(safeRetryFailedDeliveries, CHECK_INTERVAL_MS);
  setInterval(safeReconcileIncidents, CHECK_INTERVAL_MS);
  setInterval(safeMaterializeApmMetrics, APM_MATERIALIZE_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[Alarm] Başlatma hatası:", err);
  process.exit(1);
});
