-- MONGODB COLLECTOR (fan-out) -- kalan collector listesindeki "MongoDB/Kafka/RabbitMQ"
-- maddesinin ilk parçası. sql-collector'a yeni bir SÜRÜCÜ olarak eklenir (pg/mysql
-- yanına), ama SQL desenindeki "bir sorgu -> tek metrik" yerine FAN-OUT çalışır:
-- hazır "MongoDB (fan-out)" şablonu, metrik başına birer template_item içerir; her
-- item'ın connection_config'i {"field": "<seçici>"} taşır ve sürücü serverStatus'tan
-- o alanı çıkarır. Verimlilik: sürücü serverStatus'u cihaz+tur başına BİR KEZ çeker
-- (mongoCache), her item cache'ten okur -> N metrik = tek bağlantı/tur.
--
-- requires_device_config=true: kimlik bilgileri cihaz makrolarından çözülür
-- ({$MONGO_USER}/{$MONGO_PASSWORD}/{$MONGO_PORT}/{$MONGO_AUTH_DB}); makro tanımlı
-- değilse sürücü kimliksiz bağlanır (auth'suz mongod). Host = device.ip_address.
--
-- config_schema: TemplateDetail.tsx'teki 'mongodb' form bloğu 'field'i render eder
-- (kullanıcı elle item eklemek isterse). Asıl kullanım seed-default-templates.sh ile
-- gelen hazır şablondur.
INSERT INTO collector_types (key, display_name, category, config_schema, handler_service, active, requires_device_config)
VALUES ('mongodb', 'MongoDB', 'application', '{"fields": ["field"]}', 'sql-collector', true, true)
ON CONFLICT (key) DO NOTHING;
