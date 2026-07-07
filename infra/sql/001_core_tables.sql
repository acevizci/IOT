CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'trial',
    active_modules JSONB NOT NULL DEFAULT '["npm"]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, email)
);

CREATE TABLE IF NOT EXISTS devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    ip_address INET NOT NULL,
    device_type TEXT NOT NULL,
    vendor TEXT,
    snmp_config JSONB,
    attributes JSONB NOT NULL DEFAULT '{}',
    location TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, ip_address)
);
CREATE INDEX IF NOT EXISTS idx_devices_tenant_type ON devices(tenant_id, device_type);
CREATE INDEX IF NOT EXISTS idx_devices_tenant_status ON devices(tenant_id, status) WHERE status = 'active';
