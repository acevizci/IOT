-- Alarm sistemi incelemesi, bulgu 2: alarm-engine, agent'ın GERÇEK/yapılandırılabilir
-- heartbeat aralığını (services/agent/config.go HeartbeatSeconds) hiç bilmiyordu --
-- sabit 90sn (varsayılan 10sn'nin 9 katı) varsayıyordu. Farklı yapılandırılmış
-- agent'larda bu yanlış pozitif (flapping) ya da yavaş tespite yol açıyordu.
-- Varsayılan 10 -- agent'ın kendi varsayılanıyla (config.go) tutarlı, eski
-- agent binary'leri (henüz güncellenmemiş) bu alanı hiç göndermeyeceği için
-- devices tablosundaki değer varsayılanda kalır (mevcut davranış korunur).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_heartbeat_seconds INTEGER NOT NULL DEFAULT 10;

-- Alarm sistemi incelemesi, bulgu 3: 'critical' severity'si alerts tablosunda
-- (migration 006) izinliydi ama alert_rules/user_media kısıtlamalarında,
-- hiçbir zod şemasında ve frontend'in seçilebilir SEVERITY_LEVELS listesinde
-- hiç yoktu -- hiçbir kural/kanal bunu seçemiyordu, ölü bir değerdi. Kullanıcı
-- kararı: kaldırmak yerine her yere doğru şekilde eklendi (disaster'dan sonraki
-- en yüksek seviye).
ALTER TABLE alert_rules DROP CONSTRAINT IF EXISTS alert_rules_severity_check;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_severity_check
  CHECK (severity = ANY (ARRAY['info'::text, 'warning'::text, 'average'::text, 'high'::text, 'disaster'::text, 'critical'::text]));

ALTER TABLE user_media DROP CONSTRAINT IF EXISTS user_media_min_severity_check;
ALTER TABLE user_media ADD CONSTRAINT user_media_min_severity_check
  CHECK (min_severity = ANY (ARRAY['info'::text, 'warning'::text, 'average'::text, 'high'::text, 'disaster'::text, 'critical'::text]));
