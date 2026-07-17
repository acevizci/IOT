-- İLİŞKİSEL BÜTÜNLÜK DÜZELTMESİ: devices.parent_device_id ve dashboards.default_device_id
-- kolonları REFERENCES devices(id) ile tanımlanmıştı ama ON DELETE davranışı hiç
-- belirtilmemişti (varsayılan: NO ACTION/RESTRICT). 025_device_delete_cascade.sql
-- migration'ı diğer tüm devices FK'lerini bilinçli olarak CASCADE'e çevirmişti, ama bu
-- ikisi (sonradan eklendikleri için) o temizliğin kapsamı dışında kalmıştı.
--
-- Sonuç: bir üst cihazın (parent_device_id ile referans alınan) veya bir dashboard'un
-- varsayılan cihazının silinmeye çalışılması, yakalanmamış bir Postgres FK ihlaliyle
-- (500 hatası) başarısız oluyordu. CASCADE yerine SET NULL kullanıyoruz -- çünkü cihaz
-- silindiğinde ne çocuk cihazların ne de dashboard'ların kendisinin silinmesi mantıklı
-- değil, sadece referans temizlenmeli.

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_parent_device_id_fkey;
ALTER TABLE devices ADD CONSTRAINT devices_parent_device_id_fkey
  FOREIGN KEY (parent_device_id) REFERENCES devices(id) ON DELETE SET NULL;

ALTER TABLE dashboards DROP CONSTRAINT IF EXISTS dashboards_default_device_id_fkey;
ALTER TABLE dashboards ADD CONSTRAINT dashboards_default_device_id_fkey
  FOREIGN KEY (default_device_id) REFERENCES devices(id) ON DELETE SET NULL;
