-- GERÇEK EKSİKLİK DÜZELTMESİ: Coğrafi olarak dağıtık veri merkezleri/siteler için
-- Zabbix'in "Geographical maps" özelliğine karşılık gelen bir mekanizma yoktu.
-- Zabbix'te olduğu gibi koordinat host (cihaz) seviyesinde tutuluyor -- device_groups
-- tamamen mantıksal bir gruplama olduğu için (coğrafi anlamı yok), site bazlı ayrı
-- bir tablo yerine devices üzerine doğrudan nullable latitude/longitude eklendi.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
