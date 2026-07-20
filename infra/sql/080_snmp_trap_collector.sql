-- SNMP Trap Alıcısı: sistemin en büyük eksik collector'ı (kullanıcı isteği) --
-- önceki TÜM collector'lar aktif sorgulama (biz cihaza soruyoruz), bu ise PASİF
-- (cihaz bize gönderiyor). collector_types'a yeni bir kayıt, şablon sisteminin
-- (alert_templates/template_items) bu metrikleri tanıyıp alarm kuralı
-- tanımlanabilmesini sağlıyor -- gerçek "toplama" npm-service'in trapReceiver.ts'i
-- tarafından pasif olarak yapılıyor (requires_device_config=false, çünkü trap
-- alıcısı TEK bir yerden dinler, cihaz başına ayrı bağlantı config'i gerekmez).
INSERT INTO collector_types (key, display_name, category, config_schema, handler_service, active, requires_device_config)
VALUES ('snmp_trap', 'SNMP Trap (Pasif Olay)', 'network', '{"fields": []}', 'npm-service', true, false)
ON CONFLICT (key) DO NOTHING;
