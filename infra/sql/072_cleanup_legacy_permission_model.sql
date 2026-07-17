-- TEMİZLİK: Faz 1-4 (rol≠grup ayrışık modeli + LDAP) canlıda birkaç saattir
-- sorunsuz çalıştıktan ve uygulama kodunda bu kolon/tabloya hiçbir referans
-- kalmadığı doğrulandıktan sonra, eski yetki modelinin kalıntıları kaldırılıyor:
--
-- 1) user_roles.can_edit_devices/can_edit_alert_rules/can_manage_users --
--    yerini user_role_permissions (kaynak bazlı, none/read/read_write) aldı.
-- 2) role_device_group_permissions tablosu -- yerini user_group_device_permissions
--    (çoklu grup üyeliği destekleyen) aldı.
-- 3) users.role (eski düz metin alan, 'admin'/'viewer'/'operator') -- yerini
--    users.role_id (user_roles'a gerçek FK) aldı; login/register/verify-api-token
--    artık bu alanı hiç okumuyor/yazmıyor.
--
-- GERİ ALINAMAZ: bu migration'ı çalıştırmadan önce uygulamanın (core-service)
-- güncel kodla (Faz 1-4 sonrası) deploy edilmiş ve stabil çalıştığından emin olun.

ALTER TABLE user_roles DROP COLUMN IF EXISTS can_edit_devices;
ALTER TABLE user_roles DROP COLUMN IF EXISTS can_edit_alert_rules;
ALTER TABLE user_roles DROP COLUMN IF EXISTS can_manage_users;

DROP TABLE IF EXISTS role_device_group_permissions;

ALTER TABLE users DROP COLUMN IF EXISTS role;
