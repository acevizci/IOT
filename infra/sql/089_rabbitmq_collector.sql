-- RABBITMQ COLLECTOR (fan-out) -- "MongoDB/Kafka/RabbitMQ" maddesinin 3. ve son parçası.
-- Mongo/Kafka ile AYNI desen: hazır "RabbitMQ (fan-out)" şablonu, metrik başına birer
-- item, connection_config {"field": "..."} taşır. FARKI: metrikler AMQP'den değil,
-- Management HTTP API'sinden (port 15672) gelir -> yeni npm bağımlılığı YOK, sadece
-- fetch + basic auth. /api/overview + /api/nodes cihaz+tur başına BİR KEZ çekilip
-- cache'lenir (rabbitCache); per-queue derinliği 'queue' taşıyan item'larla (watch-list).
--
-- requires_device_config=true: http://device.ip:{$RABBITMQ_MGMT_PORT|15672}, basic auth
-- {$RABBITMQ_USER}/{$RABBITMQ_PASSWORD} (dev'de varsayılan guest/guest). Management
-- plugin hedefte açık olmalı (standart).
--
-- config_schema: TemplateDetail.tsx'teki 'rabbitmq' form bloğu field/queue/vhost render eder.
INSERT INTO collector_types (key, display_name, category, config_schema, handler_service, active, requires_device_config)
VALUES ('rabbitmq', 'RabbitMQ', 'application', '{"fields": ["field", "queue", "vhost"]}', 'sql-collector', true, true)
ON CONFLICT (key) DO NOTHING;
