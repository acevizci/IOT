import pg from "pg";

// Predictive Analytics: mevcut eşik-bazlı alert_rules'un HER metriği için
// otomatik eklenen, doğrusal regresyon (trend) tabanlı bir üçüncü katman.
// Anomali Tespiti'yle AYNI gölge-kural mimarisi (checkAnomaliesForRule ile
// paralel yapı) -- "şu an anormal mi" yerine "mevcut trend devam ederse NE
// ZAMAN eşiği aşacak" sorusuna cevap verir (Zabbix'in timeleft() fonksiyonu
// ve PRTG'nin Forecast sensörleriyle AYNI kapasite-planlama mantığı).

const REGRESSION_WINDOW_HOURS = Number(process.env.PREDICTIVE_REGRESSION_WINDOW_HOURS) || 6;
const MIN_REGRESSION_SAMPLES = 20; // Anomali Tespiti'ndeki MIN_BASELINE_SAMPLES ile AYNI mantık.
const MIN_R_SQUARED = Number(process.env.PREDICTIVE_MIN_R_SQUARED) || 0.7; // Gürültülü/trendsiz veride yanlış-pozitifi önler.

interface SourceRule {
  id: string;
  tenant_id: string;
  metric_name: string;
  device_id: string | null;
  condition: "gt" | "lt" | "eq" | null;
  threshold: number | null;
  severity: string;
  instance_tag_key: "interface" | "instance_label" | null;
  predictive_horizon_hours: number;
}

interface RegressionResult {
  slopePerHour: number;
  currentValue: number; // en son ham veri noktası (mesajda okunabilirlik için)
  rSquared: number;
  sampleCount: number;
}

// Gölge kuralı find-or-create eder -- ensureAnomalyRule ile AYNI idempotent
// desen (checkDeviceReachability'nin heartbeat kuralları -> anomalyDetection.ts
// -> burada üçüncü kez tekrarlanan, kanıtlanmış bir mimari).
async function ensurePredictiveRule(pool: pg.Pool, sourceRule: SourceRule): Promise<string> {
  const existing = await pool.query(
    `SELECT id FROM alert_rules WHERE source_rule_id = $1 AND is_predictive = true`,
    [sourceRule.id]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const inserted = await pool.query(
    `INSERT INTO alert_rules (tenant_id, source_module, metric_name, condition, threshold, duration_seconds, device_id, severity, is_predictive, source_rule_id, instance_tag_key)
     VALUES ($1, 'system', $2, 'gt', 0, 60, $3, $4, true, $5, $6)
     RETURNING id`,
    [sourceRule.tenant_id, sourceRule.metric_name, sourceRule.device_id, sourceRule.severity, sourceRule.id, sourceRule.instance_tag_key]
  );
  return inserted.rows[0].id;
}

// Least-squares doğrusal regresyon -- x ekseni "pencere başlangıcından bu yana
// geçen saat", y ekseni metrik değeri. R², modelin veriye ne kadar iyi uyduğunu
// gösterir (1.0 = mükemmel doğrusal ilişki, 0 = hiç ilişki yok).
function linearRegression(points: { hoursFromStart: number; value: number }[]): RegressionResult | null {
  const n = points.length;
  if (n < MIN_REGRESSION_SAMPLES) return null;

  const sumX = points.reduce((s, p) => s + p.hoursFromStart, 0);
  const sumY = points.reduce((s, p) => s + p.value, 0);
  const sumXY = points.reduce((s, p) => s + p.hoursFromStart * p.value, 0);
  const sumX2 = points.reduce((s, p) => s + p.hoursFromStart * p.hoursFromStart, 0);
  const meanY = sumY / n;

  const denominator = n * sumX2 - sumX * sumX;
  if (Math.abs(denominator) < 1e-9) return null; // Tüm noktalar aynı x'te (pratikte imkansız ama koruma).

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  const ssRes = points.reduce((s, p) => {
    const predicted = slope * p.hoursFromStart + intercept;
    return s + (p.value - predicted) ** 2;
  }, 0);
  const ssTot = points.reduce((s, p) => s + (p.value - meanY) ** 2, 0);
  const rSquared = ssTot < 1e-9 ? 0 : 1 - ssRes / ssTot; // ssTot≈0: veri sabit, trend anlamsız.

  return {
    slopePerHour: slope,
    currentValue: points[points.length - 1].value, // en son ham değer (mesaj için)
    rSquared,
    sampleCount: n
  };
}

async function getRegressionPointsByInstance(
  pool: pg.Pool, tenantId: string, deviceId: string, metricName: string,
  instanceKey: "interface" | "instance_label" | null
): Promise<Map<string, { hoursFromStart: number; value: number }[]>> {
  const result = await pool.query(
    `SELECT time, value, interface, instance_label FROM metrics
     WHERE tenant_id = $1 AND device_id = $2 AND metric_name = $3
       AND time >= now() - INTERVAL '${REGRESSION_WINDOW_HOURS} hours'
     ORDER BY time ASC`,
    [tenantId, deviceId, metricName]
  );

  if (result.rows.length === 0) return new Map();
  const windowStartMs = new Date(result.rows[0].time).getTime();

  const byInstance = new Map<string, { hoursFromStart: number; value: number }[]>();
  for (const row of result.rows) {
    const key = instanceKey === "interface" ? (row.interface ?? "")
              : instanceKey === "instance_label" ? (row.instance_label ?? "")
              : "";
    if (!byInstance.has(key)) byInstance.set(key, []);
    const hoursFromStart = (new Date(row.time).getTime() - windowStartMs) / (1000 * 60 * 60);
    byInstance.get(key)!.push({ hoursFromStart, value: Number(row.value) });
  }
  return byInstance;
}

export async function checkPredictionsForRule(pool: pg.Pool, sourceRule: SourceRule, deviceIds: string[]): Promise<void> {
  // Sadece basit sayısal koşullar (gt/lt) tahmin edilebilir -- eq'nin "trend"
  // kavramı yok (belirli bir sayıya eşit olma durumu doğrusal olarak modellenemez).
  if (sourceRule.condition !== "gt" && sourceRule.condition !== "lt") return;
  if (sourceRule.threshold === null) return;

  const predictiveRuleId = await ensurePredictiveRule(pool, sourceRule);

  for (const deviceId of deviceIds) {
    const pointsByInstance = await getRegressionPointsByInstance(
      pool, sourceRule.tenant_id, deviceId, sourceRule.metric_name, sourceRule.instance_tag_key
    );

    for (const [instanceValue, points] of pointsByInstance) {
      const regression = linearRegression(points);

      const existing = await pool.query(
        `SELECT id FROM alerts WHERE rule_id = $1 AND device_id = $2 AND instance_tag_value = $3 AND resolved_at IS NULL`,
        [predictiveRuleId, deviceId, instanceValue]
      );
      const hasOpenPrediction = existing.rows.length > 0;

      // Yetersiz veri/güvenilmez trend (düşük R²) -- ne yeni tahmin aç ne
      // mevcut olanı hemen kapat (geçici bir gürültü dalgalanması olabilir,
      // bir sonraki turda tekrar değerlendirilecek).
      if (!regression || regression.rSquared < MIN_R_SQUARED) continue;

      // Yön kontrolü: gt için sadece ARTAN trend, lt için sadece AZALAN trend anlamlı.
      const trendingTowardBreach = sourceRule.condition === "gt" ? regression.slopePerHour > 0 : regression.slopePerHour < 0;

      let hoursToBreachh: number | null = null;
      if (trendingTowardBreach) {
        const raw = (sourceRule.threshold - regression.currentValue) / regression.slopePerHour;
        if (raw > 0) hoursToBreachh = raw;
      }

      const willBreachWithinHorizon = hoursToBreachh !== null && hoursToBreachh <= sourceRule.predictive_horizon_hours;

      if (willBreachWithinHorizon && !hasOpenPrediction) {
        const instanceLabel = instanceValue ? ` [${instanceValue}]` : "";
        const conditionSymbol = sourceRule.condition === "gt" ? ">" : "<";
        const message = `${sourceRule.metric_name}${instanceLabel} tahmini: şu anki trend ile ~${hoursToBreachh!.toFixed(1)} saat sonra eşiği (${conditionSymbol} ${sourceRule.threshold}) aşacak ` +
          `(mevcut değer=${regression.currentValue.toFixed(2)}, saatlik değişim=${regression.slopePerHour >= 0 ? "+" : ""}${regression.slopePerHour.toFixed(3)}, R²=${regression.rSquared.toFixed(2)})`;

        const inserted = await pool.query(
          `INSERT INTO alerts (tenant_id, rule_id, device_id, instance_tag_value, severity, message, metric_name, is_predictive, predicted_hours_to_breach)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)
           ON CONFLICT (rule_id, device_id, instance_tag_value) WHERE resolved_at IS NULL DO NOTHING
           RETURNING id`,
          [sourceRule.tenant_id, predictiveRuleId, deviceId, instanceValue, sourceRule.severity, message, sourceRule.metric_name, hoursToBreachh]
        );
        if (inserted.rows.length > 0) {
          console.log(`[Predictive] YENİ TAHMİN: metric=${sourceRule.metric_name} device=${deviceId}${instanceLabel} ~${hoursToBreachh!.toFixed(1)}sa sonra`);
        }
      } else if (willBreachWithinHorizon && hasOpenPrediction) {
        // GERÇEK EKSİKLİK (Kapasite Tahmini widget'ı tasarlanırken bulundu):
        // açık bir tahmin alarmının "kaç saat kaldı" değeri hiç GÜNCELLENMİYORDU
        // -- alarm ilk açıldığı andaki değerde donuk kalıyordu (örn. saatler
        // geçtikçe "23.9 saat" hep aynı görünürdü). Widget'ta doğru bir geri
        // sayım/sıralama için her turda tazeleniyor.
        const instanceLabel = instanceValue ? ` [${instanceValue}]` : "";
        const conditionSymbol = sourceRule.condition === "gt" ? ">" : "<";
        const message = `${sourceRule.metric_name}${instanceLabel} tahmini: şu anki trend ile ~${hoursToBreachh!.toFixed(1)} saat sonra eşiği (${conditionSymbol} ${sourceRule.threshold}) aşacak ` +
          `(mevcut değer=${regression.currentValue.toFixed(2)}, saatlik değişim=${regression.slopePerHour >= 0 ? "+" : ""}${regression.slopePerHour.toFixed(3)}, R²=${regression.rSquared.toFixed(2)})`;
        await pool.query(
          `UPDATE alerts SET predicted_hours_to_breach = $1, message = $2
           WHERE rule_id = $3 AND device_id = $4 AND instance_tag_value = $5 AND resolved_at IS NULL`,
          [hoursToBreachh, message, predictiveRuleId, deviceId, instanceValue]
        );
      } else if (!willBreachWithinHorizon && hasOpenPrediction) {
        await pool.query(
          `UPDATE alerts SET resolved_at = now() WHERE rule_id = $1 AND device_id = $2 AND instance_tag_value = $3 AND resolved_at IS NULL`,
          [predictiveRuleId, deviceId, instanceValue]
        );
        console.log(`[Predictive] TAHMİN GEÇERSİZ (trend değişti/ufuk dışına çıktı): metric=${sourceRule.metric_name} device=${deviceId}`);
      }
    }
  }
}
