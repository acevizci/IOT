CREATE TABLE IF NOT EXISTS device_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    device_a_id UUID NOT NULL REFERENCES devices(id),
    device_b_id UUID NOT NULL REFERENCES devices(id),
    interface_a TEXT,
    interface_b TEXT,
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_links_device_a ON device_links(device_a_id);
CREATE INDEX IF NOT EXISTS idx_links_device_b ON device_links(device_b_id);

CREATE TABLE IF NOT EXISTS alert_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    source_module TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    condition TEXT NOT NULL,
    threshold NUMERIC NOT NULL,
    duration_seconds INT NOT NULL DEFAULT 300,
    device_id UUID REFERENCES devices(id),
    active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    rule_id UUID REFERENCES alert_rules(id),
    device_id UUID REFERENCES devices(id),
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    severity TEXT NOT NULL DEFAULT 'warning',
    message TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_unresolved ON alerts(tenant_id, triggered_at DESC) WHERE resolved_at IS NULL;
