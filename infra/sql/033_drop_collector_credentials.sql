-- device_collector_configs ve device_credentials, artık makro sistemine (bkz.
-- 031_macro_value_type.sql) taşınan bağlantı bilgisi mekanizmasının yerini alıyor.
--
-- NOT: Bu tablolardaki mevcut veriler (varsa) otomatik taşınmıyor — commit geçmişi
-- bunların test amaçlı olduğunu gösteriyor ("Clean up previously-wrong test items").
-- Gerçek SSH/SQL bağlantı bilgisi varsa, DROP öncesi önce şu sorguyla yedekleyin:
--   SELECT * FROM device_collector_configs;
--   SELECT id, name, credential_type, username FROM device_credentials;  -- secret hariç
-- ve Device Detail > Bağlantı Ayarları üzerinden yeni makro sistemiyle elle girin.

DROP TABLE IF EXISTS device_collector_configs;
DROP TABLE IF EXISTS device_credentials;
