-- GERİ ALINDI (kullanıcı isteği): panonun "Bağlam" çubuğu (cihaz/host grubu/
-- zaman aralığı) artık her kullanıcının kendi tarayıcısında (localStorage)
-- otomatik kalıcı oluyor (bkz. DashboardPage.tsx) -- bu yüzden ayrı, elle
-- tetiklenen ve paylaşılan bir "varsayılan bağlam" (048_dashboard_context.sql'de
-- eklenmişti, hiçbir widget tarafından hiç okunmuyordu) artık gereksiz.
ALTER TABLE dashboards DROP COLUMN IF EXISTS default_device_id;
ALTER TABLE dashboards DROP COLUMN IF EXISTS default_device_group_id;
ALTER TABLE dashboards DROP COLUMN IF EXISTS default_hours;
