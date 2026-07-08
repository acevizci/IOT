CREATE TABLE IF NOT EXISTS user_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    can_edit_devices BOOLEAN NOT NULL DEFAULT false,
    can_edit_alert_rules BOOLEAN NOT NULL DEFAULT false,
    can_manage_users BOOLEAN NOT NULL DEFAULT false,
    UNIQUE(tenant_id, name)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id UUID REFERENCES user_roles(id);

-- Mevcut tenant'lar için varsayılan rolleri oluştur (geriye dönük uyumluluk)
INSERT INTO user_roles (tenant_id, name, can_edit_devices, can_edit_alert_rules, can_manage_users)
SELECT id, 'Admin', true, true, true FROM tenants
ON CONFLICT (tenant_id, name) DO NOTHING;

INSERT INTO user_roles (tenant_id, name, can_edit_devices, can_edit_alert_rules, can_manage_users)
SELECT id, 'Viewer', false, false, false FROM tenants
ON CONFLICT (tenant_id, name) DO NOTHING;

-- Mevcut kullanıcıları (role='admin' olanlar) yeni Admin rolüne bağla
UPDATE users u SET role_id = r.id
FROM user_roles r
WHERE r.tenant_id = u.tenant_id AND r.name = 'Admin' AND u.role_id IS NULL;
