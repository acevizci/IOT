CREATE TABLE IF NOT EXISTS maintenance_windows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS maintenance_window_devices (
    maintenance_window_id UUID NOT NULL REFERENCES maintenance_windows(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    PRIMARY KEY (maintenance_window_id, device_id)
);

CREATE TABLE IF NOT EXISTS maintenance_window_groups (
    maintenance_window_id UUID NOT NULL REFERENCES maintenance_windows(id) ON DELETE CASCADE,
    device_group_id UUID NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (maintenance_window_id, device_group_id)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_windows_active ON maintenance_windows(tenant_id, starts_at, ends_at);
