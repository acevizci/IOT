-- Predictive Analytics: mevcut alert_rules'un HER metriği için otomatik
-- eklenen, doğrusal regresyon (trend) tabanlı bir üçüncü katman. Anomali
-- Tespiti'yle AYNI gölge-kural mimarisi (is_anomaly'nin is_predictive
-- eşdeğeri) -- source_rule_id kolonu zaten var (anomali için eklenmişti),
-- bir gerçek kuralın hem anomali hem predictive gölgesi aynı anda olabilir.
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS is_predictive BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS predictive_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS predictive_horizon_hours INTEGER NOT NULL DEFAULT 24;

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS is_predictive BOOLEAN NOT NULL DEFAULT false;
