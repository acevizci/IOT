-- Faz E: Agent tabanlı toplama — beşinci collector tipi (push modeli, Go binary)
ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_key_hash TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_psk TEXT; -- şifreli saklanır (CREDENTIAL_ENCRYPTION_KEY ile)
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_agent_checkin TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_version TEXT;

-- Tenant-seviyesinde agent kayıt token'ı (API Token mekanizmasıyla aynı desen)
CREATE TABLE IF NOT EXISTS agent_registration_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
