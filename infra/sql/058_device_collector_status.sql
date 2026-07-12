-- Zabbix'in "her interface tipi (Agent/SNMP/IPMI/JMX) için ayrı erişilebilirlik durumu"
-- modeline geçiş: devices.status artık tek bir SNMP-merkezli alan değil, her collector
-- tipinin (snmp/ssh_exec/sql_postgres/web_scenario vs.) kendi ayrı durumu var. 3 durumlu:
-- 'unknown' (henüz hiç kontrol edilmedi — Zabbix'in gri durumu), 'active', 'down'.
CREATE TABLE IF NOT EXISTS device_collector_status (
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    collector_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'active', 'down')),
    last_checked_at TIMESTAMPTZ,
    last_error TEXT,
    PRIMARY KEY (device_id, collector_type)
);
