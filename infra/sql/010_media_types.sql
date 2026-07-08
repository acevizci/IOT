CREATE TABLE IF NOT EXISTS media_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    type TEXT NOT NULL CHECK (type IN ('email', 'webhook')),
    name TEXT NOT NULL,
    config JSONB NOT NULL DEFAULT '{}',
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_type_id UUID NOT NULL REFERENCES media_types(id) ON DELETE CASCADE,
    destination TEXT NOT NULL,
    device_group_id UUID REFERENCES device_groups(id) ON DELETE CASCADE,
    min_severity TEXT NOT NULL DEFAULT 'warning' CHECK (min_severity IN ('info','warning','average','high','disaster')),
    active BOOLEAN NOT NULL DEFAULT true
);
