-- Şablon kütüphanesi tam denetimi: kalan tüm şablonlar tek tek incelendi.
-- Bulunanlar:
--   1) Dell iDRAC by SNMP: "dockerdocker deneme" adında, iDRAC ile alakasız
--      bir Docker item'ı yanlışlıkla eklenmiş -- siliniyor.
--   2) icmppingsec eşiği (Dell iDRAC/Generic by SNMP/ICMP Ping_Custom) "> 0"
--      idi -- gecikme her zaman >0 olduğu için fiilen işlevsizdi (Cisco'da
--      daha önce bulunup 0.5'e düzeltilen AYNI hata) -- üçü de düzeltiliyor.
--   3) "Linux by Zabbix agent MMC" ve "Linux by Zabbix agent Server" BİREBİR
--      aynı (11 item + 4 kural) -- tek, eksiksiz bir "Linux by Zabbix agent"
--      şablonunda birleştiriliyor (Windows agent şablonuyla aynı isimlendirme,
--      o da korumalı/temel). Kurallar 3 makroya ({$LOAD_AVG_PER_CPU.MAX.WARN}
--      vb.) atıfta bulunuyordu ama bu makrolar HİÇ TANIMLI DEĞİLDİ -- gerçek
--      bir cihaza uygulansaydı sessizce hiç tetiklenmezdi. Zabbix'in kendi
--      varsayılan değerleriyle tanımlanıyor.
--   4) "F5 BIG-IP Load Balancer (SNMP)" (sadece 2 item) ve "F5 Big-IP by
--      SNMP_Custom" (14 item, ama bellek item'ı YOK) birbirini tamamlayan
--      parçalar -- Cisco'daki gibi TEK "F5 BIG-IP (SNMP)" şablonunda
--      birleştiriliyor.
--   5) "Standard Server Templatee": tek item'ı (if_number_custom) boş OID'li,
--      hiçbir zaman veri üretemez; isim de yazım hatalı; 0 cihaz kullanıyor;
--      zaten çok daha eksiksiz alternatifler (Linux Server (SNMP), yeni
--      Linux by Zabbix agent) var -- siliniyor.

-- ============ 1-2) Dell iDRAC / icmppingsec düzeltmeleri ============
DELETE FROM template_items WHERE metric_name = 'dockerdocker deneme';

UPDATE alert_template_rules SET threshold = 0.5
WHERE metric_name = 'icmppingsec' AND threshold = 0
  AND template_id IN (
    SELECT id FROM alert_templates WHERE name IN ('Dell iDRAC by SNMP', 'Generic by SNMP', 'ICMP Ping_Custom')
  );

-- ============ 3) Eksik makrolar (Linux agent kurallarının bağımlı olduğu) ============
DO $$
DECLARE t RECORD;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    INSERT INTO macros (tenant_id, key, default_value, description, value_type)
    VALUES (t.id, '{$LOAD_AVG_PER_CPU.MAX.WARN}', '1.5', 'CPU başına maksimum yük ortalaması (Zabbix varsayılanı)', 'numeric')
    ON CONFLICT (tenant_id, key) DO NOTHING;
    INSERT INTO macros (tenant_id, key, default_value, description, value_type)
    VALUES (t.id, '{$SWAP.PFREE.MIN.WARN}', '50', 'Minimum boş swap yüzdesi (Zabbix varsayılanı)', 'numeric')
    ON CONFLICT (tenant_id, key) DO NOTHING;
    INSERT INTO macros (tenant_id, key, default_value, description, value_type)
    VALUES (t.id, '{$MEMORY.AVAILABLE.MIN}', '20971520', 'Minimum kullanılabilir bellek, byte (Zabbix varsayılanı: 20M)', 'numeric')
    ON CONFLICT (tenant_id, key) DO NOTHING;
  END LOOP;
END $$;

-- ============ 4) Linux by Zabbix agent (konsolide, korumalı) ============
DO $$
DECLARE
  t RECORD;
  tpl_id UUID;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    IF EXISTS (SELECT 1 FROM alert_templates WHERE tenant_id = t.id AND name = 'Linux by Zabbix agent') THEN
      CONTINUE;
    END IF;

    INSERT INTO alert_templates (tenant_id, name, device_type, is_protected)
    VALUES (t.id, 'Linux by Zabbix agent', 'server', true)
    RETURNING id INTO tpl_id;

    INSERT INTO template_items (template_id, metric_name, data_type, polling_interval_seconds, collector_type, connection_config) VALUES
      (tpl_id, 'cpu_util', 'gauge', 60, 'agent', '{}'),
      (tpl_id, 'kernel_maxproc', 'gauge', 60, 'agent', '{}'),
      (tpl_id, 'memory_available_bytes', 'gauge', 60, 'agent', '{}'),
      (tpl_id, 'memory_total_bytes', 'gauge', 60, 'agent', '{}'),
      (tpl_id, 'memory_used_percent', 'gauge', 60, 'agent', '{}'),
      (tpl_id, 'proc_num', 'gauge', 60, 'agent', '{}'),
      (tpl_id, 'system_cpu_load_all_avg1', 'gauge', 60, 'agent', '{}'),
      (tpl_id, 'system_cpu_num', 'gauge', 60, 'agent', '{}'),
      (tpl_id, 'system_swap_size_pfree', 'gauge', 60, 'agent', '{}'),
      (tpl_id, 'system_swap_size_total', 'gauge', 60, 'agent', '{}'),
      (tpl_id, 'system_uptime', 'gauge', 60, 'agent', '{}');

    INSERT INTO alert_template_rules (template_id, duration_seconds, severity, expression_ast, display_expression) VALUES
      (tpl_id, 60, 'warning',
       '{"op": "gt", "left": {"op": "mul", "left": {"op": "div", "left": {"fn": "last", "type": "function", "metric_name": "proc_num", "duration_seconds": null}, "type": "arithmetic", "right": {"fn": "last", "type": "function", "metric_name": "kernel_maxproc", "duration_seconds": null}}, "type": "arithmetic", "right": {"type": "literal", "value": 100}}, "type": "comparison", "right": {"type": "literal", "value": 80}}'::jsonb,
       'last(/Linux by Zabbix agent/proc.num)/last(/Linux by Zabbix agent/kernel.maxproc)*100>80'),
      (tpl_id, 60, 'warning',
       '{"op": "and", "type": "logical", "children": [{"op": "lt", "left": {"fn": "max", "type": "function", "metric_name": "system_swap_size_pfree", "duration_seconds": 300}, "type": "comparison", "right": {"key": "{$SWAP.PFREE.MIN.WARN}", "type": "macro"}}, {"op": "gt", "left": {"fn": "last", "type": "function", "metric_name": "system_swap_size_total", "duration_seconds": null}, "type": "comparison", "right": {"type": "literal", "value": 0}}]}'::jsonb,
       'max(/Linux by Zabbix agent/system.swap.size[,pfree],5m)<{$SWAP.PFREE.MIN.WARN} and last(/Linux by Zabbix agent/system.swap.size[,total])>0'),
      (tpl_id, 60, 'average',
       '{"op": "and", "type": "logical", "children": [{"op": "lt", "left": {"fn": "max", "type": "function", "metric_name": "memory_available_bytes", "duration_seconds": 300}, "type": "comparison", "right": {"key": "{$MEMORY.AVAILABLE.MIN}", "type": "macro"}}, {"op": "gt", "left": {"fn": "last", "type": "function", "metric_name": "memory_total_bytes", "duration_seconds": null}, "type": "comparison", "right": {"type": "literal", "value": 0}}]}'::jsonb,
       'max(/Linux by Zabbix agent/vm.memory.size[available],5m)<{$MEMORY.AVAILABLE.MIN} and last(/Linux by Zabbix agent/vm.memory.size[total])>0'),
      (tpl_id, 60, 'average',
       '{"op": "and", "type": "logical", "children": [{"op": "and", "type": "logical", "children": [{"op": "gt", "left": {"op": "div", "left": {"fn": "min", "type": "function", "metric_name": "system_cpu_load_all_avg1", "duration_seconds": 300}, "type": "arithmetic", "right": {"fn": "last", "type": "function", "metric_name": "system_cpu_num", "duration_seconds": null}}, "type": "comparison", "right": {"key": "{$LOAD_AVG_PER_CPU.MAX.WARN}", "type": "macro"}}, {"op": "gt", "left": {"fn": "last", "type": "function", "metric_name": "system_cpu_load_all_avg1", "duration_seconds": null}, "type": "comparison", "right": {"type": "literal", "value": 0}}]}, {"op": "gt", "left": {"fn": "last", "type": "function", "metric_name": "system_cpu_load_all_avg1", "duration_seconds": null}, "type": "comparison", "right": {"type": "literal", "value": 0}}]}'::jsonb,
       'min(/Linux by Zabbix agent/system.cpu.load[all,avg1],5m)/last(/Linux by Zabbix agent/system.cpu.num)>{$LOAD_AVG_PER_CPU.MAX.WARN} and last(/Linux by Zabbix agent/system.cpu.load[all,avg5])>0 and last(/Linux by Zabbix agent/system.cpu.load[all,avg15])>0');
  END LOOP;
END $$;

DELETE FROM alert_templates WHERE name IN ('Linux by Zabbix agent MMC', 'Linux by Zabbix agent Server');

-- ============ 5) F5 BIG-IP (SNMP) (konsolide) ============
DO $$
DECLARE
  t RECORD;
  tpl_id UUID;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    IF EXISTS (SELECT 1 FROM alert_templates WHERE tenant_id = t.id AND name = 'F5 BIG-IP (SNMP)') THEN
      CONTINUE;
    END IF;

    INSERT INTO alert_templates (tenant_id, name, device_type)
    VALUES (t.id, 'F5 BIG-IP (SNMP)', 'load_balancer')
    RETURNING id INTO tpl_id;

    INSERT INTO template_items (template_id, metric_name, oid, data_type, unit, polling_interval_seconds, collector_type, connection_config) VALUES
      (tpl_id, 'f5_memory_total_bytes', '1.3.6.1.4.1.3375.2.1.1.2.1.44.0', 'gauge', 'B', 60, 'snmp', '{}'),
      (tpl_id, 'f5_memory_used_bytes', '1.3.6.1.4.1.3375.2.1.1.2.1.45.0', 'gauge', 'B', 60, 'snmp', '{}'),
      (tpl_id, 'bigip_failover', '1.3.6.1.4.1.3375.2.1.14.3.1.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'bigip_syncstatus', '1.3.6.1.4.1.3375.2.1.14.1.1.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'bigip_model', '1.3.6.1.2.1.1.1.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'bigip_serialnumber', '1.3.6.1.4.1.3375.2.1.3.3.3.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'bigip_product_name', '1.3.6.1.4.1.3375.2.1.4.1.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'bigip_product_version', '1.3.6.1.4.1.3375.2.1.4.2.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'bigip_product_build', '1.3.6.1.4.1.3375.2.1.4.3.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'bigip_product_edition', '1.3.6.1.4.1.3375.2.1.4.4.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'bigip_product_date', '1.3.6.1.4.1.3375.2.1.4.5.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'bigip_uptime', '1.3.6.1.4.1.3375.2.1.6.6.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'bigip_tcp_open', '1.3.6.1.4.1.3375.2.1.1.2.12.2.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'bigip_tcp_close_wait', '1.3.6.1.4.1.3375.2.1.1.2.12.3.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'bigip_tcp_fin1_wait', '1.3.6.1.4.1.3375.2.1.1.2.12.4.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'bigip_tcp_time_wait', '1.3.6.1.4.1.3375.2.1.1.2.12.5.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'bigip_tcp_fin2_wait', '1.3.6.1.4.1.3375.2.1.1.2.12.20.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'bigip_udp_open', '1.3.6.1.4.1.3375.2.1.1.2.13.2.0', 'gauge', '', 60, 'snmp', '{}');

    INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity) VALUES
      (tpl_id, 'f5_memory_used_bytes', 'gt', 8000000000, 60, 'warning'),
      (tpl_id, 'bigip_syncstatus', 'eq', 2, 60, 'warning'),
      (tpl_id, 'bigip_syncstatus', 'eq', 4, 60, 'warning');
  END LOOP;
END $$;

DELETE FROM alert_templates WHERE name IN ('F5 BIG-IP Load Balancer (SNMP)', 'F5 Big-IP by SNMP_Custom');

-- ============ 6) Bozuk/gereksiz "Standard Server Templatee" siliniyor ============
DELETE FROM alert_templates WHERE name = 'Standard Server Templatee';
