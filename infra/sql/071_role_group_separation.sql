-- FAZ 1: Rol (yetki) / Grup (veri erişimi) ayrışık modeli — Zabbix'in
-- users_and_usergroups/permissions modeliyle birebir eşleşecek şekilde tasarlandı.
-- Bkz. mimari tartışma: rol artık SADECE "ne yapabilirim" (capability), grup ise
-- "hangi veriyi görebilirim" + auth ayarları (LDAP vb.) + çoklu üyelik.
--
-- BİLİNÇLİ KARAR: mevcut role_device_group_permissions verisi otomatik taşınmıyor
-- (kullanıcı kararı: "sıfırdan kurgulayacağız, mevcut veri önemsiz"). Bu yüzden bu
-- migration, eski tabloyu/kolonları SİLMEDEN önce yeni tabloları kurar; eski
-- role_device_group_permissions ve user_roles.can_* kolonları bir sonraki
-- migration'da (uygulama kodu tamamen yeni modele geçtikten sonra) kaldırılacak.

-- 1) Rol artık kaynak bazlı, ince taneli izinler taşıyor (eski 3 sabit boolean yerine).
CREATE TABLE IF NOT EXISTS user_role_permissions (
  role_id UUID NOT NULL REFERENCES user_roles(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('none', 'read', 'read_write')),
  PRIMARY KEY (role_id, resource)
);

-- Geçerli kaynak adları (uygulama kodunda enum olarak da doğrulanacak):
-- devices, device_groups, templates, alert_rules, maintenance, webscenarios,
-- queue, users, user_roles, user_groups, agent_releases, audit_log, dashboards,
-- macros, value_maps, topology, relations, notifications

-- 2) Grup: organizasyonel/veri-erişim birimi. Bir kullanıcı BİRDEN FAZLA gruba
-- üye olabilir (bkz. user_group_members) -- Zabbix'teki "user group" karşılığı.
CREATE TABLE IF NOT EXISTS user_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  frontend_access TEXT NOT NULL DEFAULT 'system_default'
    CHECK (frontend_access IN ('system_default', 'internal', 'ldap', 'disabled')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  debug_mode BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- 3) Çoklu üyelik: kullanıcı <-> grup (many-to-many).
CREATE TABLE IF NOT EXISTS user_group_members (
  user_group_id UUID NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (user_group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_user_group_members_user ON user_group_members(user_id);

-- 4) Grubun device_group'lara erişimi -- role_device_group_permissions'ın yeni sahibi.
-- Birden fazla grup aynı device_group'a farklı seviyede izin verirse: deny > her
-- şeyden önce gelir (aynı grupta), aksi halde read_write > read (uygulama
-- katmanında birleştirilir, bkz. resolveDeviceGroupAccess()).
CREATE TABLE IF NOT EXISTS user_group_device_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_group_id UUID NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  device_group_id UUID NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('read', 'read_write', 'deny')),
  UNIQUE (user_group_id, device_group_id)
);

-- 5) Tag-bazlı alarm/problem filtresi -- belirli bir device_group izniyle eşleşir
-- (Zabbix'te de tag filtreleri bir host group izniyle ilişkilendirilir, bağımsız
-- değildir). value boşsa "bu tag adı varsa yeter", doluysa "tag=value eşleşmeli".
CREATE TABLE IF NOT EXISTS user_group_tag_filters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_group_id UUID NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  device_group_id UUID NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  value TEXT
);

-- 6) LDAP sunucu tanımı (tenant başına). Gerçek bind/auth Faz 4'te yazılacak,
-- şema şimdiden hazırlanıyor.
CREATE TABLE IF NOT EXISTS ldap_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  port INT NOT NULL DEFAULT 389,
  bind_dn TEXT NOT NULL,
  bind_password_encrypted TEXT NOT NULL,
  base_dn TEXT NOT NULL,
  user_search_filter TEXT NOT NULL DEFAULT '(uid=%s)',
  use_tls BOOLEAN NOT NULL DEFAULT true,
  enabled BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (tenant_id)
);
