-- Faz 9.4 + 9.8 + 9.10c: panoya bağlı varsayılan bağlam (host/host grubu/zaman aralığı).
-- İki AYRI varsayılan var (9.10c) çünkü bazı widget'lar grup-seviyesinde (Top N, Severity
-- Dağılımı), bazıları cihaz-seviyesinde (Metrik Değeri, Cihaz Kartı) çalışacak — her widget
-- kendi kapsamına uygun olanı miras alır. Bu migration'da henüz hiçbir widget bu alanları
-- OKUMUYOR (o Faz 9.5'in işi) — sadece pano seviyesinde ayarlanıp kalıcı hale getiriliyor.
ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS default_device_group_id UUID REFERENCES device_groups(id);
ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS default_device_id UUID REFERENCES devices(id);
ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS default_hours INT NOT NULL DEFAULT 6;
