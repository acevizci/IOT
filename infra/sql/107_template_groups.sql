-- Şablon kütüphanesi v2: Zabbix'teki "Templates/Operating systems" tarzı
-- klasörleme -- 39 şablon artık büyüdükçe düz bir liste olarak yönetilemez.
CREATE TABLE IF NOT EXISTS template_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    UNIQUE(tenant_id, name)
);

ALTER TABLE alert_templates ADD COLUMN IF NOT EXISTS template_group_id UUID REFERENCES template_groups(id) ON DELETE SET NULL;

-- Her tenant için standart altı grup + mevcut şablonların isme göre otomatik
-- ataması (idempotent -- tekrar çalıştırılabilir, zaten atanmış olanı değiştirmez).
DO $$
DECLARE
  t RECORD;
  gid_os UUID; gid_net UUID; gid_db UUID; gid_msg UUID; gid_svc UUID; gid_virt UUID;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    INSERT INTO template_groups (tenant_id, name) VALUES (t.id, 'İşletim Sistemleri') ON CONFLICT (tenant_id, name) DO NOTHING;
    INSERT INTO template_groups (tenant_id, name) VALUES (t.id, 'Ağ Cihazları') ON CONFLICT (tenant_id, name) DO NOTHING;
    INSERT INTO template_groups (tenant_id, name) VALUES (t.id, 'Veritabanları') ON CONFLICT (tenant_id, name) DO NOTHING;
    INSERT INTO template_groups (tenant_id, name) VALUES (t.id, 'Mesajlaşma/Kuyruk') ON CONFLICT (tenant_id, name) DO NOTHING;
    INSERT INTO template_groups (tenant_id, name) VALUES (t.id, 'Servis Kontrolleri') ON CONFLICT (tenant_id, name) DO NOTHING;
    INSERT INTO template_groups (tenant_id, name) VALUES (t.id, 'Sanallaştırma') ON CONFLICT (tenant_id, name) DO NOTHING;

    SELECT id INTO gid_os FROM template_groups WHERE tenant_id = t.id AND name = 'İşletim Sistemleri';
    SELECT id INTO gid_net FROM template_groups WHERE tenant_id = t.id AND name = 'Ağ Cihazları';
    SELECT id INTO gid_db FROM template_groups WHERE tenant_id = t.id AND name = 'Veritabanları';
    SELECT id INTO gid_msg FROM template_groups WHERE tenant_id = t.id AND name = 'Mesajlaşma/Kuyruk';
    SELECT id INTO gid_svc FROM template_groups WHERE tenant_id = t.id AND name = 'Servis Kontrolleri';
    SELECT id INTO gid_virt FROM template_groups WHERE tenant_id = t.id AND name = 'Sanallaştırma';

    UPDATE alert_templates SET template_group_id = gid_os WHERE tenant_id = t.id AND template_group_id IS NULL AND name IN (
      'Linux Server (SNMP)', 'Windows by Zabbix agent', 'Windows by Zabbix agent - IzlemePC',
      'Linux by Zabbix agent MMC', 'Linux by Zabbix agent Server', 'Standard Server Templatee'
    );
    UPDATE alert_templates SET template_group_id = gid_net WHERE tenant_id = t.id AND template_group_id IS NULL AND name IN (
      'Cisco Switch/Router (SNMP)', 'Dell iDRAC by SNMP', 'F5 BIG-IP Load Balancer (SNMP)',
      'F5 Big-IP by SNMP_Custom', 'FortiGate Firewall (SNMP)', 'Generic by SNMP',
      'ICMP Ping_Custom', 'LLDP Otomatik Keşif'
    );
    UPDATE alert_templates SET template_group_id = gid_db WHERE tenant_id = t.id AND template_group_id IS NULL AND name IN (
      'PostgreSQL by Zabbix agent 2', 'MongoDB İzleme', 'Redis by Zabbix agent 2'
    );
    UPDATE alert_templates SET template_group_id = gid_msg WHERE tenant_id = t.id AND template_group_id IS NULL AND name IN (
      'Kafka Kümesi İzleme', 'RabbitMQ İzleme'
    );
    UPDATE alert_templates SET template_group_id = gid_svc WHERE tenant_id = t.id AND template_group_id IS NULL AND name IN (
      'DNS Sorgu İzleme', 'FTP Service', 'LDAP Service', 'SMTP Service', 'TLS Sertifika İzleme',
      'Elasticsearch Cluster by HTTP', 'Nginx by Zabbix agent', 'Docker by Zabbix agent 2'
    );
    UPDATE alert_templates SET template_group_id = gid_virt WHERE tenant_id = t.id AND template_group_id IS NULL AND name IN (
      'VMware - vCenter/ESXi İzleme', 'VMware Host İzleme'
    );
  END LOOP;
END $$;
