-- Duplicate cihaz kaydı bulgusu düzeltmesi: aynı isimde (aynı tenant içinde) birden fazla
-- cihaz oluşturulabiliyordu (sadece IP üzerinde benzersizlik vardı). Bu, kazara çift kayıt
-- oluşmasına ve her ikisine ayrı ayrı alarm/kural bağlanmasına yol açmıştı (Core-Switch-01
-- örneği). Şimdi tenant+isim kombinasyonu benzersiz.
ALTER TABLE devices ADD CONSTRAINT uq_devices_tenant_name UNIQUE (tenant_id, name);
