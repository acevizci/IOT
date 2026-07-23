import pg from "pg";
const { Pool } = pg;

// APM/Anomali inceleme (madde 2): APM'in RED metrikleri (hata oranı, p95/p99
// gecikme) üzerinde hiçbir alarm mekanizması yoktu -- ClickHouse'taki trace
// verisi, Postgres/Timescale tabanlı alert_rules motorunun hiç görmediği ayrı
// bir dünyaydı. YENİ bir paralel alarm motoru kurmak yerine (kod tekrarı,
// histerezis/bağımlılık/eskalasyon/anomali/tahminsel mantığının hepsinin
// ikinci bir kopyası) -- RED metriklerini periyodik olarak normal `metrics`
// tablosuna, APM servisinin zaten var olan device_id'sine (apm-sync/service,
// device_type='service') yazıyoruz. Bu sayede:
//   - Kullanıcı DeviceDetail > Şablonlar > Kurallar'dan NORMAL bir eşik kuralı
//     tanımlayabilir (metric_name='apm_error_rate_pct' vb.) -- yeni bir CRUD
//     arayüzüne gerek yok.
//   - Anomali Tespiti ve Tahminsel Analiz'in "gölge kural" mekanizması bu
//     metrikler için de OTOMATİK çalışır (hiçbir yeni kod gerekmeden).
//   - GraphWidget/host_performance_table gibi widget'lar da bu metrikleri
//     seçilebilir hale gelir (mevcut metric-name dropdown'ları ClickHouse
//     değil doğrudan `metrics` tablosunu sorguluyor).

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://clickhouse:8123";
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || "";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || "";
const CLICKHOUSE_DB = process.env.CLICKHOUSE_DB || "observability_flows";

// alarm-engine'in normal CHECK_INTERVAL_MS'inden (20sn) bağımsız, daha uzun bir
// pencere -- Agent'ın gerçek push aralığıyla (bkz. config.go MetricsSeconds,
// varsayılan 60sn) aynı büyüklük mertebesinde bir "örnekleme aralığı" fikri.
const APM_MATERIALIZE_WINDOW_SECONDS = Number(process.env.APM_MATERIALIZE_WINDOW_SECONDS) || 60;

async function queryClickHouse<T = any>(sql: string): Promise<T[]> {
  const auth = Buffer.from(`${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}`).toString("base64");
  const response = await fetch(`${CLICKHOUSE_URL}/?database=${CLICKHOUSE_DB}&default_format=JSONEachRow`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "text/plain" },
    body: sql
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ClickHouse sorgu hatası: ${response.status} ${errorText}`);
  }
  const text = await response.text();
  if (!text.trim()) return [];
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

interface ApmWindowRow {
  tenant_id: string;
  service_name: string;
  request_count: number;
  error_rate_pct: number;
  p95_ms: number;
  p99_ms: number;
}

export async function materializeApmMetrics(pool: pg.Pool): Promise<void> {
  const rows = await queryClickHouse<ApmWindowRow>(`
    SELECT
      tenant_id,
      service_name,
      count(*) AS request_count,
      round(100.0 * countIf(status_code = 2) / count(*), 2) AS error_rate_pct,
      round(quantile(0.95)(duration_ms), 1) AS p95_ms,
      round(quantile(0.99)(duration_ms), 1) AS p99_ms
    FROM traces
    WHERE timestamp >= now() - INTERVAL ${APM_MATERIALIZE_WINDOW_SECONDS} SECOND
    GROUP BY tenant_id, service_name
  `);
  if (rows.length === 0) return;

  // Aynı sorguda TÜM tenant'lardaki servisler dönüyor -- tek bir devices
  // sorgusunda hepsini eşlemek için tenant_id+service_name çiftlerini topluyoruz.
  const deviceResult = await pool.query(
    `SELECT id, tenant_id, attributes->>'apm_service_name' as service_name
     FROM devices WHERE device_type = 'service' AND attributes->>'apm_service_name' = ANY($1)`,
    [rows.map((r) => r.service_name)]
  );
  const deviceIdByKey = new Map(deviceResult.rows.map((d) => [`${d.tenant_id}:${d.service_name}`, d.id]));

  const requestsPerMin = (count: number) => Math.round((count / APM_MATERIALIZE_WINDOW_SECONDS) * 60 * 100) / 100;

  const values: any[] = [];
  const valuePlaceholders: string[] = [];
  let paramIndex = 1;
  const now = new Date();

  for (const row of rows) {
    const deviceId = deviceIdByKey.get(`${row.tenant_id}:${row.service_name}`);
    if (!deviceId) continue; // henüz senkronize olmamış servis -- bir sonraki turda tekrar denenir

    const samples: [string, number, string][] = [
      ["apm_error_rate_pct", row.error_rate_pct, "percent"],
      ["apm_p95_ms", row.p95_ms, "ms"],
      ["apm_p99_ms", row.p99_ms, "ms"],
      ["apm_requests_per_min", requestsPerMin(row.request_count), "per_min"]
    ];
    for (const [metricName, value, unit] of samples) {
      valuePlaceholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5})`);
      values.push(now, row.tenant_id, deviceId, metricName, value, unit);
      paramIndex += 6;
    }
  }
  if (values.length === 0) return;

  await pool.query(
    `INSERT INTO metrics (time, tenant_id, device_id, metric_name, value, unit) VALUES ${valuePlaceholders.join(",")}`,
    values
  );
}
