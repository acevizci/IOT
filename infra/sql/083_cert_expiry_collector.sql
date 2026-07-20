-- SERTİFİKA SÜRE SONU KONTROLÜ -- kalan collector listesindeki 2. madde. Syslog/Trap
-- PASİF alıcılardı; bu AKTİF bir collector (biz hedefe bağlanıp sertifikayı çekiyoruz).
-- tcp_port/http_json ile AYNI desen: bir template_item olarak tanımlanır, hedef host
-- cihazın IP'sidir, ek parametreler (port, SNI) connection_config'te taşınır. Gerçek
-- toplama npm-service'in multiProtocolCollectors.ts'inde (pollCertExpiry) yapılır.
--
-- requires_device_config=false: tcp_port/http_json gibi cihaz-seviyesi kimlik bilgisi
-- (SSH/SQL makroları) gerekmez; port/servername item'ın connection_config'inde durur.
--
-- config_schema: TemplateDetail.tsx'teki 'cert_expiry' form bloğu bu alanları (port,
-- servername) render eder; şema burada belgeleyici amaçlıdır.
INSERT INTO collector_types (key, display_name, category, config_schema, handler_service, active, requires_device_config)
VALUES ('cert_expiry', 'Sertifika Süre Sonu', 'application', '{"fields": ["port", "servername"]}', 'npm-service', true, false)
ON CONFLICT (key) DO NOTHING;
