-- Bildirim sistemi tasarımı ("parça parça" 4. adım, kullanıcıyla konuşulup kararlaştırıldı):
-- alarm bazında süreli sustur/ertele. Kullanıcı belirli bir alarmı üstlenmek (acknowledge)
-- istemeden -- yani "ilgileniyorum" demeden -- geçici olarak eskalasyon bildirimlerini
-- durdurabilsin ("şunu biliyoruz, X süre rahatsız etmeyin" senaryosu). Süre dolunca
-- eskalasyon otomatik kaldığı yerden devam eder.
ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ;
