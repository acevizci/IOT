-- Value map genişletmesi: if_oper_status dışında da düzinelerce 0/1 durum
-- metriği var (port kontrolü, DNS/Kafka/Mongo/RabbitMQ/TLS erişilebilirlik,
-- web senaryosu adım durumları) -- hepsi Güncel Değerler'de hâlâ ham "1"/"0"
-- gösteriyordu. İki farklı anlam kalıbı var:
--   1) "_reachable" / "_status" son eki: 1 = başarılı/erişilebilir, 0 = değil
--   2) "_any_step_failed" son eki: TERS anlam -- 1 = başarısız (hata VAR), 0 = başarılı
-- Web senaryosu metrik adları kullanıcının verdiği senaryo/adım ismine göre
-- DİNAMİK üretiliyor (sabit bir liste değil) -- bu yüzden exact-match yerine
-- son-ek (suffix) bazlı bir kural gerekiyor (bkz. core'daki resolveStatusValueMap).
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    INSERT INTO value_maps (tenant_id, name, mappings)
    VALUES (t.id, 'Erişilebilirlik Durumu', '[{"value": "1", "label": "Erişilebilir/Başarılı"}, {"value": "0", "label": "Erişilemez/Başarısız"}]'::jsonb)
    ON CONFLICT (tenant_id, name) DO NOTHING;

    INSERT INTO value_maps (tenant_id, name, mappings)
    VALUES (t.id, 'Adım Hatası Durumu', '[{"value": "1", "label": "Başarısız (hata var)"}, {"value": "0", "label": "Başarılı"}]'::jsonb)
    ON CONFLICT (tenant_id, name) DO NOTHING;
  END LOOP;
END $$;
