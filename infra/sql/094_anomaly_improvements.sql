-- Anomali Tespiti iyileştirmeleri:
-- 1) Flapping/histerezis düzeltmesi kod tarafında yapılıyor (şema gerektirmiyor).
-- 2) Kural-bazlı sigma override -- NULL ise global ANOMALY_SIGMA kullanılır
--    (predictive_horizon_hours'un anomali eşdeğeri).
-- 3) Opt-in saatlik mevsimsel baseline -- varsayılan false, mevcut düz
--    24 saatlik baseline davranışı hiçbir kural için DEĞİŞMEZ.
-- 4) Baseline canlı yeniden hesaplanan bir değer olduğu için, alarmın AÇILDIĞI
--    ANDAKİ üst/alt bandını donduruyoruz -- alert detay grafiğinde sonradan
--    mean±Nσ bandını çizebilmek için (band, sorgu zamanında değil ALARM
--    ZAMANINDA anlamlı).
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS anomaly_sigma NUMERIC;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS anomaly_seasonal BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS baseline_lower NUMERIC;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS baseline_upper NUMERIC;
