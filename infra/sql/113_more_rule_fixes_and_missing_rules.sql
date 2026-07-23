-- Genişletilmiş denetim: expression_ast İÇİNDEKİ metrik referansları da
-- kontrol edildi (önceki denetim sadece basit metric_name alanına bakıyordu,
-- expression'ları atlıyordu). Bulunanlar:
--   1) "Windows by Zabbix agent" (+ IzlemePC klonu): swap uyarı kuralı
--      "system_swap_pfree" diye YAZIM HATALI bir metriğe atıfta bulunuyordu
--      (gerçek metrik: system_swap_size_pfree) -- hiçbir zaman tetiklenmezdi.
--   2) "Redis by Zabbix agent 2": kuralı hiç var olmayan item'lara
--      (redis_clients_connected, redis_config_maxclients) VE tanımsız bir
--      makroya atıfta bulunuyordu -- şablonun GERÇEK item'ları sadece
--      redis_ping/redis_slowlog_count. Kural, var olan item'lara göre
--      yeniden yazıldı.
--   3) PostgreSQL/Kafka/MongoDB/RabbitMQ/Docker/Nginx şablonlarının HİÇBİRİNDE
--      tek bir alarm kuralı yoktu -- item'lar veri topluyordu ama hiçbir şey
--      hiçbir zaman alarm üretmiyordu. Her biri için en temel "çalışmıyor/
--      erişilemez" uyarısı ekleniyor.

-- ============ 1) Windows swap yazım hatası ============
UPDATE alert_template_rules SET
  expression_ast = replace(expression_ast::text, '"system_swap_pfree"', '"system_swap_size_pfree"')::jsonb,
  display_expression = replace(display_expression, 'system.swap.pfree', 'system.swap.size[,pfree]')
WHERE expression_ast::text LIKE '%system_swap_pfree%';

-- ============ 2) Redis kuralını var olan item'lara göre düzelt ============
DELETE FROM alert_template_rules
WHERE template_id = (SELECT id FROM alert_templates WHERE name = 'Redis by Zabbix agent 2' AND tenant_id = 'b2dbf6ab-ff81-4afc-9115-fde9a96a2fa7')
  AND expression_ast::text LIKE '%redis_clients_connected%';

-- NOT: gerçek item adı makro son ekiyle birlikte "redis_ping____REDIS_CONN_URI___"
-- (canlı ortamda ilk uygulamada fark edildi, düzeltme aşağıda ayrıca yapıldı).
INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity)
SELECT id, 'redis_ping____REDIS_CONN_URI___', 'eq', 0, 60, 'high' FROM alert_templates
WHERE name = 'Redis by Zabbix agent 2' AND tenant_id = 'b2dbf6ab-ff81-4afc-9115-fde9a96a2fa7'
  AND NOT EXISTS (SELECT 1 FROM alert_template_rules r WHERE r.template_id = alert_templates.id AND r.metric_name = 'redis_ping____REDIS_CONN_URI___');

-- ============ 3) Eksik alarm kuralları ============
INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity)
SELECT id, 'pgsql_ping____PG_URI______PG_USER______PG_PASSWORD___', 'eq', 0, 60, 'high' FROM alert_templates
WHERE name = 'PostgreSQL by Zabbix agent 2' AND tenant_id = 'b2dbf6ab-ff81-4afc-9115-fde9a96a2fa7'
  AND NOT EXISTS (SELECT 1 FROM alert_template_rules r WHERE r.template_id = alert_templates.id);

INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity)
SELECT id, 'kafka_reachable', 'eq', 0, 60, 'high' FROM alert_templates
WHERE name = 'Kafka Kümesi İzleme' AND tenant_id = 'b2dbf6ab-ff81-4afc-9115-fde9a96a2fa7'
  AND NOT EXISTS (SELECT 1 FROM alert_template_rules r WHERE r.template_id = alert_templates.id);
INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity)
SELECT id, 'kafka_offline_partitions', 'gt', 0, 60, 'high' FROM alert_templates
WHERE name = 'Kafka Kümesi İzleme' AND tenant_id = 'b2dbf6ab-ff81-4afc-9115-fde9a96a2fa7'
  AND NOT EXISTS (SELECT 1 FROM alert_template_rules r WHERE r.template_id = alert_templates.id AND r.metric_name = 'kafka_offline_partitions');

INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity)
SELECT id, 'mongo_reachable', 'eq', 0, 60, 'high' FROM alert_templates
WHERE name = 'MongoDB İzleme' AND tenant_id = 'b2dbf6ab-ff81-4afc-9115-fde9a96a2fa7'
  AND NOT EXISTS (SELECT 1 FROM alert_template_rules r WHERE r.template_id = alert_templates.id);

INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity)
SELECT id, 'rabbitmq_reachable', 'eq', 0, 60, 'high' FROM alert_templates
WHERE name = 'RabbitMQ İzleme' AND tenant_id = 'b2dbf6ab-ff81-4afc-9115-fde9a96a2fa7'
  AND NOT EXISTS (SELECT 1 FROM alert_template_rules r WHERE r.template_id = alert_templates.id);
INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity)
SELECT id, 'rabbitmq_node_running', 'eq', 0, 60, 'high' FROM alert_templates
WHERE name = 'RabbitMQ İzleme' AND tenant_id = 'b2dbf6ab-ff81-4afc-9115-fde9a96a2fa7'
  AND NOT EXISTS (SELECT 1 FROM alert_template_rules r WHERE r.template_id = alert_templates.id AND r.metric_name = 'rabbitmq_node_running');

INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity)
SELECT id, 'docker_ping', 'eq', 0, 60, 'high' FROM alert_templates
WHERE name = 'Docker by Zabbix agent 2' AND tenant_id = 'b2dbf6ab-ff81-4afc-9115-fde9a96a2fa7'
  AND NOT EXISTS (SELECT 1 FROM alert_template_rules r WHERE r.template_id = alert_templates.id);

INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity)
SELECT id, 'proc_num_nginx', 'eq', 0, 60, 'high' FROM alert_templates
WHERE name = 'Nginx by Zabbix agent' AND tenant_id = 'b2dbf6ab-ff81-4afc-9115-fde9a96a2fa7'
  AND NOT EXISTS (SELECT 1 FROM alert_template_rules r WHERE r.template_id = alert_templates.id);
