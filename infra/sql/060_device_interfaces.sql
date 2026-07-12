-- Zabbix'in "bir host'a birden fazla interface (Agent/SNMP/IPMI/JMX) eklenebilir" modeli,
-- bizim gerçek collector tiplerimize uyarlanmış: snmp/ssh/sql/web. Her biri kendi IP/port'una
-- sahip olabilir (aynı cihaz farklı protokollerle farklı adreslerden izlenebilir).
CREATE TABLE IF NOT EXISTS device_interfaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    interface_type TEXT NOT NULL CHECK (interface_type IN ('snmp', 'ssh', 'sql', 'web')),
    ip_address TEXT,
    port INT,
    snmp_community TEXT,
    UNIQUE(device_id, interface_type)
);

-- Mevcut cihazların ip_address'ini snmp interface'i olarak taşı — veri kaybı olmasın.
INSERT INTO device_interfaces (device_id, interface_type, ip_address)
SELECT id, 'snmp', ip_address FROM devices
WHERE COALESCE(attributes->>'monitoring_type', 'snmp') != 'netflow_only'
ON CONFLICT (device_id, interface_type) DO NOTHING;
