ALTER TABLE template_items ADD COLUMN IF NOT EXISTS collector_type TEXT NOT NULL DEFAULT 'snmp'
  CHECK (collector_type IN ('snmp', 'docker', 'http_json'));
ALTER TABLE template_items ADD COLUMN IF NOT EXISTS connection_config JSONB DEFAULT '{}';
ALTER TABLE template_items ALTER COLUMN oid DROP NOT NULL;

ALTER TABLE devices ADD COLUMN IF NOT EXISTS parent_device_id UUID REFERENCES devices(id);
CREATE INDEX IF NOT EXISTS idx_devices_parent ON devices(parent_device_id);
