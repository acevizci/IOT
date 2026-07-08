CREATE TABLE IF NOT EXISTS suppressed_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    rule_id UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    depends_on_rule_id UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    suppressed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_suppressed_alerts_tenant ON suppressed_alerts(tenant_id, suppressed_at DESC);
