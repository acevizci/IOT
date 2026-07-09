CREATE TABLE IF NOT EXISTS device_collector_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    collector_type TEXT NOT NULL REFERENCES collector_types(key),
    config JSONB NOT NULL DEFAULT '{}',
    UNIQUE(device_id, collector_type)
);
