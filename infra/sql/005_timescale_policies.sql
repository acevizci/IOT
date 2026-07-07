-- ============================================
-- 1. COMPRESSION — eski chunk'ları sıkıştır
-- ============================================
-- device_id + metric_name bazında segmentleme, aynı cihaz/metrik
-- verisi bir arada sıkıştırılır (sorgu performansını da artırır)
ALTER TABLE metrics SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'tenant_id, device_id, metric_name',
    timescaledb.compress_orderby = 'time DESC'
);

-- 7 günden eski chunk'lar otomatik sıkıştırılsın
SELECT add_compression_policy('metrics', INTERVAL '7 days', if_not_exists => TRUE);

-- ============================================
-- 2. RETENTION — ham veri belirli süre sonra silinsin
-- ============================================
-- Ham veri (1 dakikalık çözünürlük) 30 gün saklanır.
-- Bunun ötesi zaten rollup'larda (aşağıda) tutulacak.
SELECT add_retention_policy('metrics', INTERVAL '30 days', if_not_exists => TRUE);

-- ============================================
-- 3. CONTINUOUS AGGREGATE — 5 dakikalık rollup
-- ============================================
CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_5min
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('5 minutes', time) AS bucket,
    tenant_id,
    device_id,
    metric_name,
    interface,
    avg(value) AS avg_value,
    max(value) AS max_value,
    min(value) AS min_value,
    count(*) AS sample_count
FROM metrics
GROUP BY bucket, tenant_id, device_id, metric_name, interface
WITH NO DATA;

-- Rollup'ın ne sıklıkla güncelleneceği (her 10 dakikada bir, son 1 saatlik veriyi yeniden hesapla)
SELECT add_continuous_aggregate_policy('metrics_5min',
    start_offset => INTERVAL '1 hour',
    end_offset => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '10 minutes',
    if_not_exists => TRUE
);

-- 5 dakikalık rollup'lar için ayrı retention (6 ay saklanır — ham veriden çok daha uzun)
SELECT add_retention_policy('metrics_5min', INTERVAL '180 days', if_not_exists => TRUE);

-- ============================================
-- 4. CONTINUOUS AGGREGATE — 1 saatlik rollup (daha uzun vadeli trend analizi için)
-- ============================================
CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_1hour
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time) AS bucket,
    tenant_id,
    device_id,
    metric_name,
    interface,
    avg(value) AS avg_value,
    max(value) AS max_value,
    min(value) AS min_value,
    count(*) AS sample_count
FROM metrics
GROUP BY bucket, tenant_id, device_id, metric_name, interface
WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_1hour',
    start_offset => INTERVAL '3 hours',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE
);

-- 1 saatlik rollup'lar 2 yıl saklanır (kapasite planlama/uzun vadeli trend için)
SELECT add_retention_policy('metrics_1hour', INTERVAL '730 days', if_not_exists => TRUE);
