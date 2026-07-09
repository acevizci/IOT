CREATE TABLE IF NOT EXISTS device_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    credential_type TEXT NOT NULL CHECK (credential_type IN ('ssh_password', 'ssh_key')),
    username TEXT NOT NULL,
    encrypted_secret TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, name)
);

INSERT INTO collector_types (key, display_name, category, config_schema, handler_service) VALUES
  ('ssh_exec', 'SSH Komut Çalıştırma (Linux/Unix)', 'os', '{"fields":["host","port","credential_id","command","parse_pattern"]}', 'exec-collector')
ON CONFLICT (key) DO NOTHING;
