-- Anomali Tespiti: mevcut alert_rules'un HER metriği için otomatik olarak
-- eklenen, istatistiksel (rolling z-score) bir ikinci katman. checkDeviceReachability'nin
-- heartbeat deseniyle AYNI mantık -- her gerçek kural için "gölge" bir alert_rules
-- satırı (is_anomaly=true) oluşturulur, kendi rule_id'si sayesinde
-- (rule_id, device_id, instance_tag_value) unique constraint'inde kendi slotunu alır,
-- normal eşik-aşımı alarmıyla ÇAKIŞMAZ (ikisi aynı anda açık olabilir).
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS is_anomaly BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS source_rule_id UUID REFERENCES alert_rules(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_alert_rules_source_rule ON alert_rules (source_rule_id) WHERE source_rule_id IS NOT NULL;

-- alerts tablosuna da nodata'nın is_nodata'sıyla AYNI desende bir bayrak --
-- frontend'in anomali alarmlarını farklı gösterebilmesi için (Adım ilerleyen
-- işte netleşecek).
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS is_anomaly BOOLEAN NOT NULL DEFAULT false;
