CREATE TABLE IF NOT EXISTS collector_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    category TEXT NOT NULL,
    config_schema JSONB NOT NULL DEFAULT '{}',
    handler_service TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true
);

-- Faz A: mevcut + yeni 3 temel tip
INSERT INTO collector_types (key, display_name, category, config_schema, handler_service) VALUES
  ('snmp', 'SNMP', 'network', '{"fields":["oid"]}', 'npm-service'),
  ('icmp_ping', 'ICMP Ping', 'network', '{"fields":[]}', 'npm-service'),
  ('tcp_port', 'TCP Port Kontrolü', 'application', '{"fields":["port"]}', 'npm-service'),
  ('http_json', 'HTTP/JSON', 'application', '{"fields":["url","json_path","method"]}', 'npm-service')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE template_items ADD COLUMN IF NOT EXISTS collector_type TEXT NOT NULL DEFAULT 'snmp' REFERENCES collector_types(key);
ALTER TABLE template_items ADD COLUMN IF NOT EXISTS connection_config JSONB DEFAULT '{}';
