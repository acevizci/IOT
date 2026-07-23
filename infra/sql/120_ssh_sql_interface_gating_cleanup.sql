-- GERÇEK HATA DÜZELTMESİ (kullanıcı bulundu -- SNMP-Sim-01'de SSH kırmızı
-- görünüyordu): GET /api/v1/internal/devices?collector_type=X, o collector
-- tipine ait device_interfaces kaydı olmasa bile (LEFT JOIN ile) cihazı
-- devices.ip_address'e geri düşerek listeye dahil ediyordu -- SNMP'nin kendi
-- poller'ında zaten düzeltilen (migration 118/119) aynı sınıf hata, ama
-- ssh_exec/sql collector'ları için services/core/src/index.ts'te de vardı.
-- Kod tarafı düzeltmesi (LEFT JOIN -> JOIN) ile artık bir cihaz SADECE o
-- interface GERÇEKTEN tanımlıysa listeye giriyor. Bu migration, bugüne kadar
-- yanlışlıkla sahte ssh_exec/sql collector_status kayıtlarına düşmüş
-- cihazları temizliyor.
DELETE FROM device_collector_status dcs
USING devices d
WHERE dcs.device_id = d.id
  AND dcs.collector_type IN ('ssh_exec', 'sql')
  AND NOT EXISTS (
    SELECT 1 FROM device_interfaces di
    WHERE di.device_id = d.id
      AND di.interface_type = (CASE WHEN dcs.collector_type = 'ssh_exec' THEN 'ssh' ELSE 'sql' END)
  );
