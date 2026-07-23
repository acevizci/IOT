-- GERÇEK VERİ BOZULMASI (canlı ortamda bulundu, "no gaps" metrik taramasının
-- SON adımında): bugün snmpPoller.ts'e eklenen baseline arayüz hata/düşme
-- sayaçları (if_in_errors vb., template'siz, TÜM cihazlarda otomatik) ile
-- "Linux Server (SNMP)" şablonundaki ÖNCEDEN VAR OLAN, is_table (walk) SNMP
-- özelliğini göstermek için elle eklenmiş bir test/demo item'ı AYNI metric_name'i
-- ("if_in_errors") kullanıyordu -- SNMP-Sim-01 ve NetFlow-Exporter-01 cihazlarında
-- İKİ FARKLI POLLER aynı anda aynı satıra yazıyordu: biri ham kümülatif sayaç
-- (benim yeni kodum), diğeri preprocessing ile hesaplanmış bir ORAN (eski demo
-- item, ör. "1.02 hata/sn") -- canlı veride ardışık satırlarda 190568 (ham) ve
-- 0.965 (oran) gibi tutarsız değerler görülerek doğrulandı.
--
-- Artık if_in_errors/if_out_errors/if_in_discards/if_out_discards TÜM SNMP
-- cihazlarında otomatik/baseline olarak toplandığı için bu elle eklenmiş demo
-- item'a gerek kalmadı -- ama is_table (walk) özelliğinin canlı bir örneği
-- olarak İŞLEVİ korunuyor, sadece çakışmayı önlemek için metric_name'i
-- değiştiriliyor (silinmiyor).
UPDATE template_items
SET metric_name = 'if_in_errors_table_demo'
WHERE id = '6066524f-5f7e-48a9-b5dd-4c3f308ccee4'
  AND metric_name = 'if_in_errors';
