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

const ANOMALY_SIGMA = Number(process.env.ANOMALY_SIGMA) || 3; // Endüstri standardı varsayılan (%99.7 güven aralığı) -- kural anomaly_sigma override'ı NULL ise kullanılır.
const ANOMALY_RECOVERY_RATIO = Number(process.env.ANOMALY_RECOVERY_RATIO) || 0.7; // Histerezis: kapanış sigma'sı = açılış sigma'sı * bu oran.
const BASELINE_WINDOW_HOURS = Number(process.env.ANOMALY_BASELINE_HOURS) || 24;
const SEASONAL_WINDOW_DAYS = Number(process.env.ANOMALY_SEASONAL_WINDOW_DAYS) || 14; // anomaly_seasonal=true kurallar için.
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
  // Kural-bazlı sigma override -- null ise global ANOMALY_SIGMA kullanılır.
  anomaly_sigma: number | null;
  // true ise baseline "son BASELINE_WINDOW_HOURS saat" yerine "son
  // SEASONAL_WINDOW_DAYS gün, GÜNÜN AYNI SAATİ" örnekleminden hesaplanır --
  // mesai-saati gibi günlük döngüsü olan metriklerde yanlış-pozitif/negatifi
  // azaltır (haftalık döngü -- hafta içi/sonu farkı -- modellenmiyor, bilinen
  // bir sınırlama).
  anomaly_seasonal: boolean;
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
  instanceKey: "interface" | "instance_label" | null, instanceValue: string, durationSeconds: number,
  seasonal: boolean
): Promise<{ mean: number; stddev: number; sampleCount: number } | null> {
  const instanceFilter = instanceKey
    ? `AND COALESCE(${instanceKey}, '') = $5`
    : "";
  const params: any[] = [tenantId, deviceId, metricName, durationSeconds];
  if (instanceKey) params.push(instanceValue);

  // Mevsimsel mod: "son N gün" yerine "son N gün İÇİNDE, GÜNÜN AYNI SAATİ" --
  // düz pencereyle aynı örneklem alt sınırı (MIN_BASELINE_SAMPLES) ve aynı
  // "değerlendirme penceresini hariç tut" kuralı geçerli.
  const timeFilter = seasonal
    ? `AND time >= now() - INTERVAL '${SEASONAL_WINDOW_DAYS} days' AND EXTRACT(HOUR FROM time) = EXTRACT(HOUR FROM now())`
    : `AND time >= now() - INTERVAL '${BASELINE_WINDOW_HOURS} hours'`;

  const result = await pool.query(
    `SELECT avg(value) as mean, stddev(value) as stddev, count(*) as sample_count
     FROM metrics
     WHERE tenant_id = $1 AND device_id = $2 AND metric_name = $3
       ${timeFilter}
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
  const openSigma = sourceRule.anomaly_sigma ?? ANOMALY_SIGMA;
  const recoverySigma = openSigma * ANOMALY_RECOVERY_RATIO;
  const windowLabel = sourceRule.anomaly_seasonal ? `${SEASONAL_WINDOW_DAYS} gün (günün aynı saati)` : `${BASELINE_WINDOW_HOURS}sa`;

  for (const deviceId of deviceIds) {
    const latestByInstance = await getLatestValuesByInstance(
      pool, sourceRule.tenant_id, deviceId, sourceRule.metric_name, sourceRule.instance_tag_key, sourceRule.duration_seconds
    );

    for (const [instanceValue, latestValue] of latestByInstance) {
      const baseline = await computeBaseline(
        pool, sourceRule.tenant_id, deviceId, sourceRule.metric_name,
        sourceRule.instance_tag_key, instanceValue, sourceRule.duration_seconds, sourceRule.anomaly_seasonal
      );
      // Yetersiz geçmiş veri (örn. yeni eklenmiş bir cihaz/metrik) -- anomali
      // değerlendirilemez, sessizce atla (ne alarm aç ne kapat, mevcut durum korunur).
      if (!baseline) continue;

      const zScore = (latestValue - baseline.mean) / baseline.stddev;
      const absZ = Math.abs(zScore);

      const existing = await pool.query(
        `SELECT id FROM alerts WHERE rule_id = $1 AND device_id = $2 AND instance_tag_value = $3 AND resolved_at IS NULL`,
        [anomalyRuleId, deviceId, instanceValue]
      );
      const hasOpenAnomaly = existing.rows.length > 0;

      // GERÇEK HATA SINIFI (canlı testte anomali listesinde bulundu): tek bir
      // ham veri noktasının z-score'unu SABİT bir eşiğe karşı test etmek,
      // sınırdaki (örn. tam 3.0σ) bir metriğin her turda aç/kapa yapmasına
      // (flapping) yol açıyordu. Normal eşik kurallarındaki recovery_threshold
      // histerezis bandıyla AYNI çözüm: açılış ve kapanış için FARKLI eşikler
      // -- açıkken kapanmak için daha DÜŞÜK bir sigma'nın altına inmek gerekir.
      const shouldBeOpen = hasOpenAnomaly ? absZ >= recoverySigma : absZ >= openSigma;

      if (shouldBeOpen && !hasOpenAnomaly) {
        const instanceLabel = instanceValue ? ` [${instanceValue}]` : "";
        const direction = zScore > 0 ? "üzerinde" : "altında";
        const message = `${sourceRule.metric_name}${instanceLabel} anormal: değer=${latestValue.toFixed(2)}, ` +
          `${windowLabel} ortalama=${baseline.mean.toFixed(2)} (±${baseline.stddev.toFixed(2)}), ` +
          `${absZ.toFixed(1)}σ ${direction} (n=${baseline.sampleCount})`;
        // Baseline canlı yeniden hesaplanan bir değer -- alarmın AÇILDIĞI
        // ANDAKİ bandı donduruyoruz ki alert detay grafiği daha sonra (baseline
        // artık farklı olsa bile) o anki mean±sigma bandını çizebilsin.
        const baselineLower = baseline.mean - openSigma * baseline.stddev;
        const baselineUpper = baseline.mean + openSigma * baseline.stddev;

        const inserted = await pool.query(
          `INSERT INTO alerts (tenant_id, rule_id, device_id, instance_tag_value, severity, message, metric_name, is_anomaly, baseline_lower, baseline_upper, value)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10)
           ON CONFLICT (rule_id, device_id, instance_tag_value) WHERE resolved_at IS NULL DO NOTHING
           RETURNING id`,
          [sourceRule.tenant_id, anomalyRuleId, deviceId, instanceValue, sourceRule.severity, message, sourceRule.metric_name, baselineLower, baselineUpper, latestValue]
        );
        if (inserted.rows.length > 0) {
          console.log(`[Anomaly] YENİ ANOMALİ: metric=${sourceRule.metric_name} device=${deviceId}${instanceLabel} z=${zScore.toFixed(2)}`);
        }
      } else if (!shouldBeOpen && hasOpenAnomaly) {
        await pool.query(
          `UPDATE alerts SET resolved_at = now() WHERE rule_id = $1 AND device_id = $2 AND instance_tag_value = $3 AND resolved_at IS NULL`,
          [anomalyRuleId, deviceId, instanceValue]
        );
        console.log(`[Anomaly] NORMALE DÖNDÜ: metric=${sourceRule.metric_name} device=${deviceId}`);
      }
    }
  }
}
