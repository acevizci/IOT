-- DNS COLLECTOR (Mod A: cihaz = DNS sunucusu) -- kalan collector listesindeki sıradaki
-- madde. Cert gibi AKTİF bir collector; cihazın IP'sini bir DNS sunucusu kabul edip ona
-- yapılandırılan bir adı sorar, yanıt süresini ve kayıt dönüp dönmediğini ölçer.
-- tcp_port/http_json/cert_expiry ile AYNI desen: bir template_item, hedef host cihazın
-- IP'si, ek parametreler connection_config'te. Toplama multiProtocolCollectors.ts'te
-- (pollDns) yapılır.
--
-- requires_device_config=false: cihaz-seviyesi kimlik bilgisi gerekmez; sorgu adı/tip/
-- port item'ın connection_config'inde durur.
--
-- config_schema: TemplateDetail.tsx'teki 'dns' form bloğu bu alanları render eder
-- (query_name = sorulacak ad, record_type = A/AAAA/MX/..., port = 53, expected = yanıtta
-- aranan opsiyonel alt-dize).
INSERT INTO collector_types (key, display_name, category, config_schema, handler_service, active, requires_device_config)
VALUES ('dns', 'DNS Sorgu (Sunucu İzleme)', 'network', '{"fields": ["query_name", "record_type", "port", "expected"]}', 'npm-service', true, false)
ON CONFLICT (key) DO NOTHING;
