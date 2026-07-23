-- Şablon kütüphanesi temizliği: kullanıcı ile birlikte yapılan detaylı inceleme
-- sonucu (54 şablon, sadece 11 gerçek cihaz, çoğu boş/dağınık/kopuk).
--
-- Kapsam: her collector type için TEK, eksiksiz "temel şablon" (device sayısından
-- bağımsız, Zabbix'in resmi şablon kütüphanesi gibi). Bu migration:
--   1) İçeriği sağlam ama ismi yanıltıcı olan şablonları yeniden adlandırır
--   2) Hiçbir yerde referans edilmeyen, tamamen boş 14 şablonu siler
--   3) template_items.item_group + device_templates.enabled_groups ekler --
--      "Windows servisleri" gibi opsiyonel alt-grupları AYRI bir şablon yerine
--      ana şablonun içinde, cihaz bazında aç/kapa edilebilir bir grup yapar
--      (ekran görüntüsünde görülen gerçek Zabbix "Windows by Zabbix agent"
--      şablonunun "Windows services discovery" discovery rule'ıyla AYNI mantık)
--   4) 6 parçalı/dağınık Cisco şablonunu TEK, eksiksiz bir şablonda birleştirir
--   5) Bozuk cihaz atamalarını (boş/yanlış şablon, hiç şablon yok) düzeltir

-- ============ 1) YENİDEN ADLANDIRMA ============
-- İçerikleri incelendi: kafka/mongodb/rabbitmq/dns collector'larının GERÇEK,
-- kullanılabilir item'larını içeriyorlar -- "Test" ismi yanıltıcıydı.
UPDATE alert_templates SET name = 'Kafka Kümesi İzleme' WHERE name = 'Kafka Test';
UPDATE alert_templates SET name = 'MongoDB İzleme' WHERE name = 'Mongo Test';
UPDATE alert_templates SET name = 'RabbitMQ İzleme' WHERE name = 'Rabbit Test';
UPDATE alert_templates SET name = 'DNS Sorgu İzleme' WHERE name = 'DNS Test';

-- ============ 2) ÖLÜ ŞABLONLARI SİL ============
-- Hepsi 0 item, hiçbir cihaza atanmamış (Template_Cisco_2960 hariç -- o da 0 item,
-- aşağıda cihaz ataması düzeltiliyor), ve kod tarafında isme göre HİÇBİR YERDE
-- referans edilmiyor (LLDP Otomatik Keşif İSTİSNA -- npm/src/db.ts + index.ts'te
-- isme göre eşleşiyor, o silinmiyor). "Windows PDH-WMI Test" bu oturumdaki CPU
-- hata ayıklaması için oluşturulmuştu, CPU kapsamı zaten Windows şablonunda var.
DELETE FROM alert_templates WHERE name IN (
  'Interfaces by SNMP',
  'Macro Test Template',
  'NTP Service',
  'RabbitMQ node by Zabbix agent',
  'Systemd by Zabbix agent 2',
  'Template Cisco General',
  'Template_Cisco_Traps',
  'Template_Cisco_2960',
  'Veeam Backup and Replication by HTTP',
  'Zabbix agent',
  'Zabbix agent active',
  'Zabbix proxy health',
  'Zabbix server health',
  'Windows PDH-WMI Test'
);

-- ============ 3) OPSİYONEL ITEM GRUBU MEKANİZMASI ============
-- item_group NULL = her zaman aktif ("core"). Dolu ise, o grup device_templates
-- satırındaki enabled_groups dizisinde YOKSA bu item o cihaz için TOPLANMAZ.
ALTER TABLE template_items ADD COLUMN IF NOT EXISTS item_group TEXT;
ALTER TABLE device_templates ADD COLUMN IF NOT EXISTS enabled_groups TEXT[] NOT NULL DEFAULT '{}';

-- ============ 4) WINDOWS SERVİSLERİNİ ANA ŞABLONA TAŞI ============
-- "Windows - Tüm Servisler İzleme" ayrı bir şablondu -- ama gerçek Zabbix'te
-- (ekran görüntüsünde doğrulandı) bu, "Windows by Zabbix agent" şablonunun
-- İÇİNDEKİ bir discovery rule. Her tenant'ın Windows şablonuna item_group=
-- 'services' ile ekleniyor, varsayılan KAPALI (enabled_groups boş dizi) --
-- yüzlerce servisin hepsini izlemek gürültülü olabileceği için isteğe bağlı.
DO $$
DECLARE
  tpl RECORD;
BEGIN
  FOR tpl IN SELECT id FROM alert_templates WHERE name = 'Windows by Zabbix agent' LOOP
    IF NOT EXISTS (SELECT 1 FROM template_items WHERE template_id = tpl.id AND metric_name = 'windows_service_running') THEN
      INSERT INTO template_items (template_id, metric_name, data_type, polling_interval_seconds, is_table, collector_type, connection_config, item_group)
      VALUES (tpl.id, 'windows_service_running', 'gauge', 60, true, 'agent', '{"action": "service_state", "plugin": "wmi"}', 'services');
    END IF;
  END LOOP;
END $$;

DELETE FROM alert_templates WHERE name = 'Windows - Tüm Servisler İzleme';

-- ============ 5) CISCO ŞABLONLARINI BİRLEŞTİR ============
-- 6 parçalı şablon incelendi: hiçbiri tek başına eksiksiz değil (biri sadece
-- CPU/RAM, diğerleri sadece sistem bilgisi+ping, donanım OID'leri bazılarında
-- ".1001"/".149" gibi belirli bir cihaza sabitlenmiş). Tek, eksiksiz ve
-- cihazdan bağımsız (chassis index olarak standart ".1" kullanan) bir şablonda
-- birleştiriliyor, mevcut alarm kuralları (CPU/RAM/ping/reboot tespiti) da
-- taşınıyor -- ping gecikmesi eşiği (icmppingsec>0, her zaman doğru olduğu için
-- fiilen işlevsizdi) 500ms'ye düzeltildi. cisco_memory_used_percent kuralı
-- ESKİDEN hiçbir item'ın üretmediği bir metriğe atıfta bulunuyordu (sadece ham
-- bytes item'ları vardı) -- şimdi memory_used_percent_formula ile AYNI desende
-- gerçek bir formül item'ı olarak ekleniyor.
DO $$
DECLARE
  t RECORD;
  tpl_id UUID;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    IF EXISTS (SELECT 1 FROM alert_templates WHERE tenant_id = t.id AND name = 'Cisco Switch/Router (SNMP)') THEN
      CONTINUE;
    END IF;

    INSERT INTO alert_templates (tenant_id, name, device_type)
    VALUES (t.id, 'Cisco Switch/Router (SNMP)', 'switch')
    RETURNING id INTO tpl_id;

    INSERT INTO template_items (template_id, metric_name, oid, data_type, unit, polling_interval_seconds, collector_type, connection_config) VALUES
      (tpl_id, 'system_descr', '1.3.6.1.2.1.1.1.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'system_contact', '1.3.6.1.2.1.1.4.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'system_name', '1.3.6.1.2.1.1.5.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'system_location', '1.3.6.1.2.1.1.6.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'system_objectid', '1.3.6.1.2.1.1.2.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'system_net_uptime', '1.3.6.1.2.1.1.3.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'system_hw_uptime', '1.3.6.1.2.1.25.1.1.0', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'system_hw_model', '1.3.6.1.2.1.47.1.1.1.1.13.1', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'system_hw_serialnumber', '1.3.6.1.2.1.47.1.1.1.1.11.1', 'gauge', '', 60, 'snmp', '{}'),
      (tpl_id, 'cisco_cpu_5min', '1.3.6.1.4.1.9.9.109.1.1.1.1.5.1', 'gauge', '%', 60, 'snmp', '{}'),
      (tpl_id, 'cisco_memory_used_bytes', '1.3.6.1.4.1.9.9.48.1.1.1.5.1', 'gauge', 'B', 60, 'snmp', '{}'),
      (tpl_id, 'cisco_memory_free_bytes', '1.3.6.1.4.1.9.9.48.1.1.1.6.1', 'gauge', 'B', 60, 'snmp', '{}'),
      (tpl_id, 'icmpping', NULL, 'gauge', '', 60, 'icmp_ping', '{}'),
      (tpl_id, 'icmppingloss', NULL, 'gauge', '%', 60, 'icmp_ping', '{}'),
      (tpl_id, 'icmppingsec', NULL, 'gauge', 's', 60, 'icmp_ping', '{}');

    -- cisco_memory_used_percent: ESKİDEN alarm kuralı bu metriğe atıfta
    -- bulunuyordu ama hiçbir item onu ÜRETMİYORDU (sadece ham bytes vardı) --
    -- memory_used_percent_formula ile AYNI desende gerçek bir formül item'ı.
    INSERT INTO template_items (template_id, metric_name, data_type, unit, polling_interval_seconds, collector_type, connection_config, formula, formula_oids) VALUES
      (tpl_id, 'cisco_memory_used_percent', 'gauge', 'percent', 60, 'snmp', '{}',
       'used/(used+free)*100',
       '{"used": "1.3.6.1.4.1.9.9.48.1.1.1.5.1", "free": "1.3.6.1.4.1.9.9.48.1.1.1.6.1"}'::jsonb);

    INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity) VALUES
      (tpl_id, 'icmpping', 'eq', 0, 60, 'high'),
      (tpl_id, 'icmppingsec', 'gt', 0.5, 60, 'warning'),
      (tpl_id, 'cisco_cpu_5min', 'gt', 85, 300, 'high'),
      (tpl_id, 'cisco_memory_used_percent', 'gt', 90, 300, 'high');

    INSERT INTO alert_template_rules (template_id, duration_seconds, severity, expression_ast, display_expression) VALUES
      (tpl_id, 60, 'warning',
       '{"op": "or", "type": "logical", "children": [{"op": "and", "type": "logical", "children": [{"op": "gt", "left": {"fn": "last", "type": "function", "metric_name": "system_hw_uptime", "duration_seconds": null}, "type": "comparison", "right": {"type": "literal", "value": 0}}, {"op": "lt", "left": {"fn": "last", "type": "function", "metric_name": "system_hw_uptime", "duration_seconds": null}, "type": "comparison", "right": {"type": "literal", "value": 600}}]}, {"op": "and", "type": "logical", "children": [{"op": "eq", "left": {"fn": "last", "type": "function", "metric_name": "system_hw_uptime", "duration_seconds": null}, "type": "comparison", "right": {"type": "literal", "value": 0}}, {"op": "lt", "left": {"fn": "last", "type": "function", "metric_name": "system_net_uptime", "duration_seconds": null}, "type": "comparison", "right": {"type": "literal", "value": 600}}]}]}'::jsonb,
       '(last(/Cisco Switch/Router (SNMP)/system.hw.uptime)>0 and last(/Cisco Switch/Router (SNMP)/system.hw.uptime)<10m) or (last(/Cisco Switch/Router (SNMP)/system.hw.uptime)=0 and last(/Cisco Switch/Router (SNMP)/system.net.uptime)<10m)');
  END LOOP;
END $$;

-- Eski parçalı Cisco şablonlarını sil (yalnızca gerçek cihazlara atanmış olanlar
-- aşağıdaki bölümde yeni şablona taşınıyor).
DELETE FROM alert_templates WHERE name IN (
  'Cisco IOS by SNMP',
  'Cisco IOS by SNMP_Kenar_Switch',
  'Cisco IOS by SNMP_Omurga_Switch',
  'Saha_sw_Cisco Nexus 9000 Series by SNMP2',
  'WM_Cisco Nexus by SNMP',
  'Cisco IOS Switch/Router (SNMP)'
);

-- ============ 6) BOZUK CİHAZ ATAMALARINI DÜZELT ============
-- Core-Switch-01: hiç şablon atanmamıştı -- yeni Cisco şablonu atanıyor.
-- NetFlow-Exporter-01: yanlış "Linux Server (SNMP)" ataması kaldırılıyor
-- (Template_Cisco_2960 zaten yukarıda silindiği için device_templates satırı
-- otomatik temizlendi), yeni Cisco şablonu atanıyor.
DO $$
DECLARE
  tenant_id_val UUID := 'b2dbf6ab-ff81-4afc-9115-fde9a96a2fa7';
  cisco_tpl_id UUID;
  core_switch_id UUID;
  netflow_id UUID;
BEGIN
  SELECT id INTO cisco_tpl_id FROM alert_templates WHERE tenant_id = tenant_id_val AND name = 'Cisco Switch/Router (SNMP)';
  SELECT id INTO core_switch_id FROM devices WHERE tenant_id = tenant_id_val AND name = 'Core-Switch-01';
  SELECT id INTO netflow_id FROM devices WHERE tenant_id = tenant_id_val AND name = 'NetFlow-Exporter-01';

  IF cisco_tpl_id IS NOT NULL AND core_switch_id IS NOT NULL THEN
    INSERT INTO device_templates (device_id, template_id) VALUES (core_switch_id, cisco_tpl_id)
    ON CONFLICT DO NOTHING;
  END IF;

  IF netflow_id IS NOT NULL THEN
    DELETE FROM device_templates WHERE device_id = netflow_id
      AND template_id = (SELECT id FROM alert_templates WHERE tenant_id = tenant_id_val AND name = 'Linux Server (SNMP)');
    IF cisco_tpl_id IS NOT NULL THEN
      INSERT INTO device_templates (device_id, template_id) VALUES (netflow_id, cisco_tpl_id)
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
END $$;
