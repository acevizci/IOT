-- Cihaz silindiğinde bağlı kayıtların da temizlenmesi için CASCADE ekle
-- (önceki kısıtları düşürüp CASCADE'li olarak yeniden oluşturuyoruz)

ALTER TABLE alert_rules DROP CONSTRAINT IF EXISTS alert_rules_device_id_fkey;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_device_id_fkey
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE;

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_device_id_fkey;
ALTER TABLE alerts ADD CONSTRAINT alerts_device_id_fkey
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE;

ALTER TABLE device_links DROP CONSTRAINT IF EXISTS device_links_device_a_id_fkey;
ALTER TABLE device_links ADD CONSTRAINT device_links_device_a_id_fkey
  FOREIGN KEY (device_a_id) REFERENCES devices(id) ON DELETE CASCADE;

ALTER TABLE device_links DROP CONSTRAINT IF EXISTS device_links_device_b_id_fkey;
ALTER TABLE device_links ADD CONSTRAINT device_links_device_b_id_fkey
  FOREIGN KEY (device_b_id) REFERENCES devices(id) ON DELETE CASCADE;

ALTER TABLE suppressed_alerts DROP CONSTRAINT IF EXISTS suppressed_alerts_device_id_fkey;
ALTER TABLE suppressed_alerts ADD CONSTRAINT suppressed_alerts_device_id_fkey
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE;

ALTER TABLE suppressed_alerts DROP CONSTRAINT IF EXISTS suppressed_alerts_rule_id_fkey;
ALTER TABLE suppressed_alerts ADD CONSTRAINT suppressed_alerts_rule_id_fkey
  FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE;

ALTER TABLE suppressed_alerts DROP CONSTRAINT IF EXISTS suppressed_alerts_depends_on_rule_id_fkey;
ALTER TABLE suppressed_alerts ADD CONSTRAINT suppressed_alerts_depends_on_rule_id_fkey
  FOREIGN KEY (depends_on_rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE;

ALTER TABLE maintenance_window_devices DROP CONSTRAINT IF EXISTS maintenance_window_devices_device_id_fkey;
ALTER TABLE maintenance_window_devices ADD CONSTRAINT maintenance_window_devices_device_id_fkey
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE;
