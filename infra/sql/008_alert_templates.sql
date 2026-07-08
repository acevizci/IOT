CREATE TABLE IF NOT EXISTS alert_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    device_type TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS alert_template_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES alert_templates(id) ON DELETE CASCADE,
    metric_name TEXT NOT NULL,
    condition TEXT NOT NULL,
    threshold NUMERIC NOT NULL,
    duration_seconds INT NOT NULL DEFAULT 60,
    severity TEXT NOT NULL DEFAULT 'warning'
);

ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS template_rule_id UUID REFERENCES alert_template_rules(id) ON DELETE SET NULL;
