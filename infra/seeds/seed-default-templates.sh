#!/bin/bash
# Varsayılan, gerçek/doğrulanmış OID'lere sahip template'leri oluşturur.
# Kullanım: TOKEN=<jwt> ./seed-default-templates.sh
# Kaynaklar: Cisco resmi CPU/Memory SNMP dokümanları, Fortinet Community,
# F5 resmi F5-BIGIP-SYSTEM-MIB dokümantasyonu (2026-07-08 tarihinde doğrulandı).

set -e
GATEWAY_URL="${GATEWAY_URL:-http://localhost:8080}"

if [ -z "$TOKEN" ]; then
  echo "Hata: TOKEN ortam değişkeni tanımlı değil. Önce giriş yapıp token alın."
  exit 1
fi

create_template() {
  curl -s -X POST "$GATEWAY_URL/api/v1/alert-templates" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "$1"
}

create_item() {
  curl -s -X POST "$GATEWAY_URL/api/v1/alert-templates/$1/items" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "$2"
}

echo "== Linux Server (SNMP) =="
LINUX_ID=$(create_template '{"name":"Linux Server (SNMP)","device_type":"server","rules":[{"metric_name":"memory_used_percent","condition":"gt","threshold":90,"duration_seconds":300,"severity":"high"},{"metric_name":"cpu_load_1min","condition":"gt","threshold":4,"duration_seconds":300,"severity":"warning"},{"metric_name":"if_oper_status","condition":"lt","threshold":1,"duration_seconds":60,"severity":"disaster"}]}' | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
echo "Template ID: $LINUX_ID"

echo "== Cisco IOS Switch/Router (SNMP) =="
CISCO_ID=$(create_template '{"name":"Cisco IOS Switch/Router (SNMP)","device_type":"switch","rules":[{"metric_name":"cisco_cpu_5min","condition":"gt","threshold":85,"duration_seconds":300,"severity":"high"},{"metric_name":"cisco_memory_used_percent","condition":"gt","threshold":90,"duration_seconds":300,"severity":"high"}]}' | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
echo "Template ID: $CISCO_ID"
create_item "$CISCO_ID" '{"metric_name":"cisco_cpu_5min","oid":"1.3.6.1.4.1.9.9.109.1.1.1.1.5.1","data_type":"gauge","unit":"percent","polling_interval_seconds":60,"is_table":false}'
create_item "$CISCO_ID" '{"metric_name":"cisco_memory_used_bytes","oid":"1.3.6.1.4.1.9.9.48.1.1.1.5.1","data_type":"gauge","unit":"bytes","polling_interval_seconds":60,"is_table":false}'
create_item "$CISCO_ID" '{"metric_name":"cisco_memory_free_bytes","oid":"1.3.6.1.4.1.9.9.48.1.1.1.6.1","data_type":"gauge","unit":"bytes","polling_interval_seconds":60,"is_table":false}'

echo "== FortiGate Firewall (SNMP) =="
FORTI_ID=$(create_template '{"name":"FortiGate Firewall (SNMP)","device_type":"firewall","rules":[{"metric_name":"fortigate_cpu_percent","condition":"gt","threshold":85,"duration_seconds":300,"severity":"high"},{"metric_name":"fortigate_memory_percent","condition":"gt","threshold":90,"duration_seconds":300,"severity":"high"}]}' | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
echo "Template ID: $FORTI_ID"
create_item "$FORTI_ID" '{"metric_name":"fortigate_cpu_percent","oid":"1.3.6.1.4.1.12356.101.4.1.3.0","data_type":"gauge","unit":"percent","polling_interval_seconds":60,"is_table":false}'
create_item "$FORTI_ID" '{"metric_name":"fortigate_memory_percent","oid":"1.3.6.1.4.1.12356.101.4.1.4.0","data_type":"gauge","unit":"percent","polling_interval_seconds":60,"is_table":false}'
create_item "$FORTI_ID" '{"metric_name":"fortigate_session_count","oid":"1.3.6.1.4.1.12356.101.4.1.8.0","data_type":"gauge","unit":"count","polling_interval_seconds":60,"is_table":false}'

echo "== F5 BIG-IP Load Balancer (SNMP) =="
F5_ID=$(create_template '{"name":"F5 BIG-IP Load Balancer (SNMP)","device_type":"load_balancer","rules":[{"metric_name":"f5_memory_used_bytes","condition":"gt","threshold":8000000000,"duration_seconds":300,"severity":"warning"}]}' | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
echo "Template ID: $F5_ID"
create_item "$F5_ID" '{"metric_name":"f5_memory_total_bytes","oid":"1.3.6.1.4.1.3375.2.1.1.2.1.44.0","data_type":"gauge","unit":"bytes","polling_interval_seconds":60,"is_table":false}'
create_item "$F5_ID" '{"metric_name":"f5_memory_used_bytes","oid":"1.3.6.1.4.1.3375.2.1.1.2.1.45.0","data_type":"gauge","unit":"bytes","polling_interval_seconds":60,"is_table":false}'

echo "== MongoDB (fan-out) =="
# SQL/SNMP şablonlarından farkı: item'lar collector_type=mongodb ve connection_config
# {"field": "<serverStatus yolu ya da özel seçici>"} taşır. Kimlik cihaz makrolarından
# ({$MONGO_USER}/{$MONGO_PASSWORD}/{$MONGO_PORT}) -- item'da tekrar edilmez.
MONGO_ID=$(create_template '{"name":"MongoDB (fan-out)","device_type":"server","rules":[{"metric_name":"mongo_reachable","condition":"lt","threshold":1,"duration_seconds":60,"severity":"disaster"},{"metric_name":"mongo_repl_lag","condition":"gt","threshold":30,"duration_seconds":300,"severity":"high"},{"metric_name":"mongo_connections_current","condition":"gt","threshold":20000,"duration_seconds":300,"severity":"warning"},{"metric_name":"mongo_global_lock_queue_total","condition":"gt","threshold":100,"duration_seconds":300,"severity":"warning"}]}' | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
echo "Template ID: $MONGO_ID"

add_mongo() { # $1=metric_name $2=field $3=unit
  create_item "$MONGO_ID" "{\"metric_name\":\"$1\",\"collector_type\":\"mongodb\",\"connection_config\":{\"field\":\"$2\"},\"data_type\":\"gauge\",\"unit\":\"$3\",\"polling_interval_seconds\":60,\"is_table\":false}" > /dev/null
}
add_mongo mongo_reachable                reachable                                       status
add_mongo mongo_connections_current      connections.current                             count
add_mongo mongo_connections_available    connections.available                           count
add_mongo mongo_opcounters_query         opcounters.query                                count
add_mongo mongo_opcounters_insert        opcounters.insert                               count
add_mongo mongo_opcounters_update        opcounters.update                               count
add_mongo mongo_opcounters_delete        opcounters.delete                               count
add_mongo mongo_opcounters_command       opcounters.command                              count
add_mongo mongo_mem_resident             "mem.resident"                                  MB
add_mongo mongo_mem_virtual              "mem.virtual"                                   MB
add_mongo mongo_global_lock_queue_total  globalLock.currentQueue.total                   count
add_mongo mongo_wt_cache_used            "wiredTiger.cache.bytes currently in the cache" bytes
add_mongo mongo_network_bytes_in         network.bytesIn                                 bytes
add_mongo mongo_network_bytes_out        network.bytesOut                                bytes
add_mongo mongo_asserts_user             asserts.user                                    count
add_mongo mongo_uptime                   uptime                                          sn
add_mongo mongo_repl_lag                 repl_lag                                        sn
add_mongo mongo_repl_state               repl_state                                      enum
echo "MongoDB şablonu: 18 item eklendi."

echo "== Kafka (fan-out) =="
# Küresel item'lar (field ile). Consumer lag deployment'a özel grup adı gerektirdiği için
# şablona konmaz -- kullanıcı 'kafka' collector'lı, connection_config {"field":"consumer_lag",
# "group":"<grup>"} olan item'ları kendisi ekler (watch-list). kafka_consumer_lag alarm
# kuralı yine de tanımlıdır; ilgili lag item'ı eklendiğinde devreye girer.
KAFKA_ID=$(create_template '{"name":"Kafka (fan-out)","device_type":"server","rules":[{"metric_name":"kafka_reachable","condition":"lt","threshold":1,"duration_seconds":60,"severity":"disaster"},{"metric_name":"kafka_offline_partitions","condition":"gt","threshold":0,"duration_seconds":60,"severity":"disaster"},{"metric_name":"kafka_under_replicated_partitions","condition":"gt","threshold":0,"duration_seconds":300,"severity":"high"},{"metric_name":"kafka_consumer_lag","condition":"gt","threshold":100000,"duration_seconds":300,"severity":"warning"}]}' | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
echo "Template ID: $KAFKA_ID"

add_kafka() { # $1=metric_name $2=field $3=unit
  create_item "$KAFKA_ID" "{\"metric_name\":\"$1\",\"collector_type\":\"kafka\",\"connection_config\":{\"field\":\"$2\"},\"data_type\":\"gauge\",\"unit\":\"$3\",\"polling_interval_seconds\":60,\"is_table\":false}" > /dev/null
}
add_kafka kafka_reachable                    reachable                    status
add_kafka kafka_broker_count                 broker_count                 count
add_kafka kafka_controller_present           controller_present           status
add_kafka kafka_topic_count                  topic_count                  count
add_kafka kafka_partition_count              partition_count              count
add_kafka kafka_under_replicated_partitions  under_replicated_partitions  count
add_kafka kafka_offline_partitions           offline_partitions           count
add_kafka kafka_consumer_group_count         consumer_group_count         count
echo "Kafka şablonu: 8 küresel item eklendi (consumer lag item'ları kullanıcı tarafından)."

echo "== RabbitMQ (fan-out) =="
# Küresel item'lar (field ile). Per-queue derinliği deployment'a özel kuyruk adı
# gerektirdiği için şablona konmaz -- kullanıcı 'rabbitmq' collector'lı, connection_config
# {"field":"queue_messages","queue":"<kuyruk>"} olan item'ları kendisi ekler (watch-list).
RABBIT_ID=$(create_template '{"name":"RabbitMQ (fan-out)","device_type":"server","rules":[{"metric_name":"rabbitmq_reachable","condition":"lt","threshold":1,"duration_seconds":60,"severity":"disaster"},{"metric_name":"rabbitmq_disk_alarm","condition":"gt","threshold":0,"duration_seconds":60,"severity":"disaster"},{"metric_name":"rabbitmq_node_running","condition":"lt","threshold":1,"duration_seconds":60,"severity":"disaster"},{"metric_name":"rabbitmq_mem_alarm","condition":"gt","threshold":0,"duration_seconds":120,"severity":"high"},{"metric_name":"rabbitmq_messages_ready","condition":"gt","threshold":100000,"duration_seconds":300,"severity":"warning"}]}' | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
echo "Template ID: $RABBIT_ID"

add_rabbit() { # $1=metric_name $2=field $3=unit
  create_item "$RABBIT_ID" "{\"metric_name\":\"$1\",\"collector_type\":\"rabbitmq\",\"connection_config\":{\"field\":\"$2\"},\"data_type\":\"gauge\",\"unit\":\"$3\",\"polling_interval_seconds\":60,\"is_table\":false}" > /dev/null
}
add_rabbit rabbitmq_reachable         reachable          status
add_rabbit rabbitmq_messages_total    messages_total     mesaj
add_rabbit rabbitmq_messages_ready    messages_ready     mesaj
add_rabbit rabbitmq_messages_unacked  messages_unacked   mesaj
add_rabbit rabbitmq_publish_rate      publish_rate       msg/s
add_rabbit rabbitmq_deliver_rate      deliver_rate       msg/s
add_rabbit rabbitmq_ack_rate          ack_rate           msg/s
add_rabbit rabbitmq_connections       connections        adet
add_rabbit rabbitmq_channels          channels           adet
add_rabbit rabbitmq_consumers         consumers          adet
add_rabbit rabbitmq_queues            queues             adet
add_rabbit rabbitmq_node_mem_used     node_mem_used      bytes
add_rabbit rabbitmq_node_mem_limit    node_mem_limit     bytes
add_rabbit rabbitmq_node_disk_free    node_disk_free     bytes
add_rabbit rabbitmq_node_fd_used      node_fd_used       adet
add_rabbit rabbitmq_mem_alarm         mem_alarm          status
add_rabbit rabbitmq_disk_alarm        disk_alarm         status
add_rabbit rabbitmq_node_running      node_running       status
echo "RabbitMQ şablonu: 18 küresel item eklendi (queue derinliği item'ları kullanıcı tarafından)."

echo "Tamamlandı — 7 template oluşturuldu (4 SNMP + MongoDB + Kafka + RabbitMQ)."
