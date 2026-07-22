import pg from "pg";
const { Pool } = pg;

// Anomali Tespiti: mevcut eşik-bazlı alert_rules'un HER metriği için otomatik
// eklenen, rolling z-score tabanlı istatistiksel katman. checkDeviceReachability'nin
// heartbeat deseniyle AYNI mantık -- her gerçek kural için "gölge" bir alert_rules
// satırı (is_anomaly=true) find-or-create edilir; anomali alarmları o gölge
// kuralın rule_id'siyle açılır, kendi (rule_id,device_id,instance) unique
// constraint slotunu alır, normal eşik alarmıyla ÇAKIŞMAZ (ikisi aynı anda açık
// olabilir -- örn. CPU %85 eşiği aşmamış ama geçmişe göre istatistiksel olarak
// anormal olabilir).

const ANOMALY_SIGMA = Number(process.env.ANOMALY_SIGMA) || 3; // Endüstri standardı varsayılan (%99.7 güven aralığı)
const BASELINE_WINDOW_HOURS = Number(process.env.ANOMALY_BASELINE_HOURS) || 24;
const MIN_BASELINE_SAMPLES = 20; // Yetersiz veriyle stddev güvenilmez.
const MIN_STDDEV_EPSILON = 0.01; // Neredeyse-sabit metriklerde sıfıra bölme/aşırı hassasiyeti önler.

interface SourceRule {
  id: string;
  tenant_id: string;
  metric_name: string;
  device_id: string | null;
  duration_seconds: number;
  severity: string;
  instance_tag_key: "interface" | "instance_label" | null;
}

// Gerçek bir eşik kuralı için gölge anomali kuralını find-or-create eder --
// checkDeviceReachability'deki heartbeat kural deseniyle AYNI idempotent yaklaşım.
async function ensureAnomalyRule(pool: pg.Pool, sourceRule: SourceRule): Promise<string> {
  const existing = await pool.query(
    `SELECT id FROM alert_rules WHERE source_rule_id = $1 AND is_anomaly = true`,
    [sourceRule.id]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  // chk_simple_or_expression kısıtlaması metric_name+condition VEYA expression_ast
  // ister -- gölge kural asla normal akışa girmeyeceği için (getActiveRules
  // is_anomaly=false filtreliyor) condition/threshold'un DEĞERİ önemsiz, sadece
  // kısıtlamayı sözdizimsel olarak sağlamak için yer tutucu.
  const inserted = await pool.query(
    `INSERT INTO alert_rules (tenant_id, source_module, metric_name, condition, threshold, duration_seconds, device_id, severity, is_anomaly, source_rule_id, instance_tag_key)
     VALUES ($1, 'system', $2, 'gt', 0, $3, $4, $5, true, $6, $7)
     RETURNING id`,
    [sourceRule.tenant_id, sourceRule.metric_name, sourceRule.duration_seconds, sourceRule.device_id, sourceRule.severity, sourceRule.id, sourceRule.instance_tag_key]
  );
  return inserted.rows[0].id;
}

// Bir (device,metric,instance) üçlüsü için baseline (mean+stddev) hesaplar --
// DEĞERLENDİRME PENCERESİNİ (son duration_seconds) HARİÇ TUTARAK, yoksa yeni
// anormal veri kendi baseline'ını kirletir (örn. CPU aniden sıçrarsa, o veri
// ortalamaya karışıp "aslında normalmiş" gibi görünmesine sebep olur).
async function computeBaseline(
  pool: pg.Pool, tenantId: string, deviceId: string, metricName: string,
  instanceKey: "interface" | "instance_label" | null, instanceValue: string, durationSeconds: number
): Promise<{ mean: number; stddev: number; sampleCount: number } | null> {
  const instanceFilter = instanceKey
    ? `AND COALESCE(${instanceKey}, '') = $5`
    : "";
  const params: any[] = [tenantId, deviceId, metricName, durationSeconds];
  if (instanceKey) params.push(instanceValue);

  const result = await pool.query(
    `SELECT avg(value) as mean, stddev(value) as stddev, count(*) as sample_count
     FROM metrics
     WHERE tenant_id = $1 AND device_id = $2 AND metric_name = $3
       AND time >= now() - INTERVAL '${BASELINE_WINDOW_HOURS} hours'
       AND time < now() - ($4 || ' seconds')::interval
       ${instanceFilter}`,
    params
  );

  const row = result.rows[0];
  const sampleCount = Number(row?.sample_count || 0);
  if (sampleCount < MIN_BASELINE_SAMPLES) return null;

  return {
    mean: Number(row.mean),
    stddev: Math.max(Number(row.stddev) || 0, MIN_STDDEV_EPSILON),
    sampleCount
  };
}

// Değerlendirme penceresindeki (son duration_seconds) en son değeri alır --
// evaluateRuleForDevice ile AYNI instance-gruplama mantığı (Faz J.0), tek fark
// burada koşul eşiği değil z-score hesaplanıyor.
async function getLatestValuesByInstance(
  pool: pg.Pool, tenantId: string, deviceId: string, metricName: string,
  instanceKey: "interface" | "instance_label" | null, durationSeconds: number
): Promise<Map<string, number>> {
  const result = await pool.query(
    `SELECT value, interface, instance_label, time FROM metrics
     WHERE tenant_id = $1 AND device_id = $2 AND metric_name = $3
       AND time >= now() - ($4 || ' seconds')::interval
     ORDER BY time DESC`,
    [tenantId, deviceId, metricName, durationSeconds]
  );

  const latestByInstance = new Map<string, number>();
  for (const row of result.rows) {
    const key = instanceKey === "interface" ? (row.interface ?? "")
              : instanceKey === "instance_label" ? (row.instance_label ?? "")
              : "";
    if (!latestByInstance.has(key)) latestByInstance.set(key, Number(row.value)); // İlk (en yeni) değeri al
  }
  return latestByInstance;
}

export async function checkAnomaliesForRule(pool: pg.Pool, sourceRule: SourceRule, deviceIds: string[]): Promise<void> {
  const anomalyRuleId = await ensureAnomalyRule(pool, sourceRule);

  for (const deviceId of deviceIds) {
    const latestByInstance = await getLatestValuesByInstance(
      pool, sourceRule.tenant_id, deviceId, sourceRule.metric_name, sourceRule.instance_tag_key, sourceRule.duration_seconds
    );

    for (const [instanceValue, latestValue] of latestByInstance) {
      const baseline = await computeBaseline(
        pool, sourceRule.tenant_id, deviceId, sourceRule.metric_name,
        sourceRule.instance_tag_key, instanceValue, sourceRule.duration_seconds
      );
      // Yetersiz geçmiş veri (örn. yeni eklenmiş bir cihaz/metrik) -- anomali
      // değerlendirilemez, sessizce atla (ne alarm aç ne kapat, mevcut durum korunur).
      if (!baseline) continue;

      const zScore = (latestValue - baseline.mean) / baseline.stddev;
      const isAnomalous = Math.abs(zScore) >= ANOMALY_SIGMA;

      const existing = await pool.query(
        `SELECT id FROM alerts WHERE rule_id = $1 AND device_id = $2 AND instance_tag_value = $3 AND resolved_at IS NULL`,
        [anomalyRuleId, deviceId, instanceValue]
      );
      const hasOpenAnomaly = existing.rows.length > 0;

      if (isAnomalous && !hasOpenAnomaly) {
        const instanceLabel = instanceValue ? ` [${instanceValue}]` : "";
        const direction = zScore > 0 ? "üzerinde" : "altında";
        const message = `${sourceRule.metric_name}${instanceLabel} anormal: değer=${latestValue.toFixed(2)}, ` +
          `${BASELINE_WINDOW_HOURS}sa ortalama=${baseline.mean.toFixed(2)} (±${baseline.stddev.toFixed(2)}), ` +
          `${Math.abs(zScore).toFixed(1)}σ ${direction} (n=${baseline.sampleCount})`;

        const inserted = await pool.query(
          `INSERT INTO alerts (tenant_id, rule_id, device_id, instance_tag_value, severity, message, metric_name, is_anomaly)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true)
           ON CONFLICT (rule_id, device_id, instance_tag_value) WHERE resolved_at IS NULL DO NOTHING
           RETURNING id`,
          [sourceRule.tenant_id, anomalyRuleId, deviceId, instanceValue, sourceRule.severity, message, sourceRule.metric_name]
        );
        if (inserted.rows.length > 0) {
          console.log(`[Anomaly] YENİ ANOMALİ: metric=${sourceRule.metric_name} device=${deviceId}${instanceLabel} z=${zScore.toFixed(2)}`);
        }
      } else if (!isAnomalous && hasOpenAnomaly) {
        await pool.query(
          `UPDATE alerts SET resolved_at = now() WHERE rule_id = $1 AND device_id = $2 AND instance_tag_value = $3 AND resolved_at IS NULL`,
          [anomalyRuleId, deviceId, instanceValue]
        );
        console.log(`[Anomaly] NORMALE DÖNDÜ: metric=${sourceRule.metric_name} device=${deviceId}`);
      }
    }
  }
}
