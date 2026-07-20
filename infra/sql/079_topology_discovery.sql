-- Topoloji: otomatik keşif (LLDP/CDP) desteği. device_links tablosu şimdiye kadar
-- SADECE kullanıcının manuel eklediği bağlantıları tutuyordu -- artık npm-service'in
-- SNMP üzerinden LLDP-MIB (ve gelecekte CDP) sorgulayarak OTOMATİK keşfettiği
-- bağlantıları da AYNI tabloda, ayrı bir işaretle tutuyoruz (frontend'de farklı
-- görsel stil için). Mevcut discovered_at kolonu, keşif sırasında "son görülme
-- zamanı" olarak da güncellenecek (UPSERT ile).
ALTER TABLE device_links ADD COLUMN IF NOT EXISTS discovery_method TEXT DEFAULT 'manual';

-- Mevcut idx_device_links_unique_pair SADECE cihaz çiftine bakıyordu (interface'i
-- hesaba katmıyordu) -- LLDP keşfinde aynı iki cihaz arasında BİRDEN FAZLA fiziksel
-- port bağlantısı olabilir (LAG/trunk gibi), bu yüzden interface çiftini de
-- içeren bir kısıtlamaya geçiyoruz (yön-bağımsızlık LEAST/GREATEST ile korunuyor).
DROP INDEX IF EXISTS idx_device_links_unique_pair;
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_links_unique_pair
  ON device_links (tenant_id, LEAST(device_a_id, device_b_id), GREATEST(device_a_id, device_b_id), COALESCE(interface_a, ''), COALESCE(interface_b, ''));
