-- FAZ J.0 — Tag-farkında alarm motoru (VMware/Hyper-V'den BAĞIMSIZ bir ön koşul).
--
-- KÖK SEBEP: evaluateRuleForDevice, metric_name+device_id eşleşen TÜM satırları
-- (farklı interface'ler/instance'lar dahil) karıştırıp rows.every() ile TEK blok
-- değerlendiriyordu -- çok-instance'lı bir metrikte (örn. 5 interface'ten sadece 1'i
-- hatalıyken) diğer 4 interface'in temiz satırları .every()'i başarısız kılıp alarmın
-- HİÇ tetiklenmemesine yol açabiliyordu. Bu, mevcut SNMP interface alarmlarını da
-- etkileyebilecek bir platform sorunu (VMware'e özel değil).
--
-- TASARIM İLKESİ (sıfır regresyon): instance_tag_key NULL olduğunda davranış eskisiyle
-- BİREBİR aynı (tüm satırlar tek grup ''). Mevcut hiçbir trigger/kural etkilenmiyor.

-- 1) metrics: VMware/Hyper-V (ve gelecekteki diğer çoklu-instance kaynaklar) için
--    ikinci genel amaçlı kolon. `interface`'e DOKUNULMUYOR (SNMP'ye özel kalır).
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS instance_label TEXT;

-- 2) alert_rules: hangi kolona göre gruplanacağını seçen kolon.
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS instance_tag_key text
  CHECK (instance_tag_key IS NULL OR instance_tag_key IN ('interface', 'instance_label'));

-- 2b) alert_template_rules: ŞABLON tanımı seviyesinde de aynı kolon -- rule bir template'ten
-- (örn. import_zabbix_templates.py'nin is_table:true item'lardan ürettiği kurallar) geliyorsa,
-- instance_tag_key BURADA tanımlanır ve applyTemplateRulesToDevices() cihaza uygularken
-- alert_rules'a KOPYALAR (aşağıdaki uygulama kodu değişikliğine bkz.).
ALTER TABLE alert_template_rules ADD COLUMN IF NOT EXISTS instance_tag_key text
  CHECK (instance_tag_key IS NULL OR instance_tag_key IN ('interface', 'instance_label'));

-- 3) alerts: instance-bazlı açık-alarm ayrımı.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS instance_tag_value text NOT NULL DEFAULT '';
  -- '' = cihaz-seviyesi (mevcut TÜM alarmlar burada kalır, geriye dönük uyumlu)

DROP INDEX IF EXISTS uq_alerts_open_rule_device;
CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_open_rule_device_instance
  ON alerts (rule_id, device_id, instance_tag_value) WHERE resolved_at IS NULL;
