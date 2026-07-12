-- Yeni cihazlar artık 'active' (sağlıklı) yerine 'unknown' (bilinmiyor) ile başlıyor —
-- ilk gerçek kontrol yapılana kadar Zabbix'in gri "henüz kontrol edilmedi" durumuna
-- karşılık gelir. Böylece hiç kontrol edilmemiş bir cihaz yanlışlıkla "sağlıklı" görünmez.
ALTER TABLE devices ALTER COLUMN status SET DEFAULT 'unknown';
