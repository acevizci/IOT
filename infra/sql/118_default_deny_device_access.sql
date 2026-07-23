-- GÜVENLİK DÜZELTMESİ (kullanıcı yönetimi denetimi -- kullanıcı isteğiyle):
-- resolveDeviceGroupAccess() önceden, bir kullanıcının HİÇBİR user_group'a üye
-- olmaması durumunda "kısıtlama yok" (tüm tenant cihazları görünür) varsayıyordu
-- -- yani her yeni kullanıcı, bir gruba eklenene kadar TÜM cihazları görüyordu.
-- Bu "fail-open" varsayılan artık "fail-closed"a (varsayılan deny) çevriliyor.
--
-- Geriye dönük uyumluluk için: bu migration, HALİHAZIRDA hiçbir gruba üye
-- olmayan (yani bugün "kısıtlama yok" davranışından yararlanan) her kullanıcıyı,
-- yeni "grants_all_devices=true" (wildcard/tüm cihazlara açık erişim) bayrağı
-- taşıyan bir "Tüm Cihazlara Erişim (Legacy)" grubuna otomatik ekliyor --
-- yani bu kullanıcıların BUGÜNKÜ efektif erişimi DEĞİŞMİYOR, sadece implicit
-- (kodun sessizce varsaydığı) bir davranış yerine explicit (DB'de görünür,
-- denetlenebilir) bir gruba dönüşüyor. Kod tarafındaki değişiklik (boş harita
-- artık deny) ayrı olarak services/core/src/index.ts'te yapıldı.
ALTER TABLE user_groups ADD COLUMN IF NOT EXISTS grants_all_devices BOOLEAN NOT NULL DEFAULT false;

DO $$
DECLARE
  t RECORD;
  legacy_group_id UUID;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    SELECT id INTO legacy_group_id FROM user_groups
      WHERE tenant_id = t.id AND name = 'Tüm Cihazlara Erişim (Legacy)';

    IF legacy_group_id IS NULL THEN
      INSERT INTO user_groups (tenant_id, name, grants_all_devices)
      VALUES (t.id, 'Tüm Cihazlara Erişim (Legacy)', true)
      RETURNING id INTO legacy_group_id;
    END IF;

    INSERT INTO user_group_members (user_group_id, user_id)
    SELECT legacy_group_id, u.id
    FROM users u
    WHERE u.tenant_id = t.id
      AND NOT EXISTS (SELECT 1 FROM user_group_members ugm WHERE ugm.user_id = u.id)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
