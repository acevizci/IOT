-- KAFKA COLLECTOR (fan-out) -- "MongoDB/Kafka/RabbitMQ" maddesinin 2. parçası.
-- MongoDB ile AYNI desen: hazır "Kafka (fan-out)" şablonu, metrik başına birer item,
-- connection_config {"field": "..."} taşır ve sürücü küresel bundle'dan çıkarır.
-- Küresel bundle (describeCluster + listTopics + fetchTopicMetadata + listGroups) cihaz+
-- tur başına TEK admin bağlantısıyla çekilip cache'lenir (kafkaCache) -> N küresel metrik
-- = tek bağlantı/tur.
--
-- Per-instance: consumer lag item'ları connection_config'te 'group' (+opsiyonel 'topic')
-- taşır (field="consumer_lag") -> watch-list, doğal sınır. instance_label = grup.
--
-- requires_device_config=true: brokers = device.ip:{$KAFKA_PORT|9092}; opsiyonel SASL
-- ({$KAFKA_USER}/{$KAFKA_PASSWORD} + sasl_mechanism/ssl makroları). Makro yoksa düz bağlanır.
--
-- config_schema: TemplateDetail.tsx'teki 'kafka' form bloğu field/group/topic'i render eder.
INSERT INTO collector_types (key, display_name, category, config_schema, handler_service, active, requires_device_config)
VALUES ('kafka', 'Kafka', 'application', '{"fields": ["field", "group", "topic"]}', 'sql-collector', true, true)
ON CONFLICT (key) DO NOTHING;
