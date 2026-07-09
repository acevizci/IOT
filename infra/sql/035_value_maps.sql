CREATE TABLE IF NOT EXISTS value_maps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    mappings JSONB NOT NULL DEFAULT '[]',
    UNIQUE(tenant_id, name)
);

ALTER TABLE template_items ADD COLUMN IF NOT EXISTS value_map_id UUID REFERENCES value_maps(id);
