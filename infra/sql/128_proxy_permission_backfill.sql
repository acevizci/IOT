-- GERÇEK EKSİKLİK (kullanıcıyla konuşulup bulundu): "proxies" kaynağı sadece
-- /api/v1/auth/register'daki (yeni tenant kaydı) seed mantığına eklendi -- ama
-- user_role_permissions her kaynak için AYRI bir satır tutuyor (dinamik/varsayılan
-- değer YOK, bkz. resolvePermissionsForRole: satır yoksa seviye "none" sayılır).
-- Bu yüzden bu migration'dan ÖNCE oluşturulmuş tenant'ların TÜM rollerinde "proxies"
-- için hiç satır yoktu -- hasPermission() bunu "none" sayıp admin dahil HERKESİ
-- proxy uçlarından (token oluşturma, proxy ayarları) 403 ile dışlıyordu.
--
-- Isıtıcı: rolün "devices" kaynağında read_write'a sahip olması, o rolün gerçek
-- admin rolü (register akışında TÜM kaynaklara read_write verilen rol) olduğunun
-- güvenilir bir işareti -- proxies ADMIN_ONLY_RESOURCES'e eklendiği için (agent_releases
-- ile aynı hassasiyet seviyesi), bu roller read_write, diğerleri none alır.
INSERT INTO user_role_permissions (role_id, resource, level)
SELECT r.id, 'proxies',
  CASE WHEN devices_perm.level = 'read_write' THEN 'read_write' ELSE 'none' END
FROM user_roles r
LEFT JOIN user_role_permissions devices_perm
  ON devices_perm.role_id = r.id AND devices_perm.resource = 'devices'
WHERE NOT EXISTS (
  SELECT 1 FROM user_role_permissions urp
  WHERE urp.role_id = r.id AND urp.resource = 'proxies'
);
