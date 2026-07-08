CREATE TABLE IF NOT EXISTS macros (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    key TEXT NOT NULL,
    default_value NUMERIC NOT NULL,
    description TEXT,
    UNIQUE(tenant_id, key)
);

CREATE TABLE IF NOT EXISTS macro_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    macro_id UUID NOT NULL REFERENCES macros(id) ON DELETE CASCADE,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('device', 'device_group')),
    scope_id UUID NOT NULL,
    value NUMERIC NOT NULL,
    UNIQUE(macro_id, scope_type, scope_id)
);

ALTER TABLE alert_template_rules ADD COLUMN IF NOT EXISTS threshold_macro_key TEXT;
