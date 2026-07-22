-- Anomali Tespiti opt-out: kullanıcı, gürültülü/volatil bir metrik için
-- anomali izlemeyi kural bazında kapatabilsin (Datadog'un monitör-bazlı
-- mute/disable esnekliğiyle AYNI mantık). Varsayılan true -- "otomatik,
-- istenirse kapat" kullanıcı kararıyla tutarlı.
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS anomaly_enabled BOOLEAN NOT NULL DEFAULT true;
