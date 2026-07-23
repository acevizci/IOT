-- Şablon kütüphanesi v2: kanonik ("temel") şablonları yanlışlıkla bozmaya karşı
-- koruma. is_protected=true olan şablonlarda item/kural ekleme-silme-değiştirme
-- backend'de reddedilir -- değişiklik için önce klonlanması gerekir (bkz.
-- POST /alert-templates/:id/clone). Bugün temizlenen/konsolide edilen dört
-- şablon (tüm tenant'larda) korumaya alınıyor.
ALTER TABLE alert_templates ADD COLUMN IF NOT EXISTS is_protected BOOLEAN NOT NULL DEFAULT false;

UPDATE alert_templates SET is_protected = true
WHERE name IN ('Windows by Zabbix agent', 'Cisco Switch/Router (SNMP)', 'Linux Server (SNMP)', 'TLS Sertifika İzleme');
