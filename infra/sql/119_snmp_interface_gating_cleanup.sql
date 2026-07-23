-- GERÇEK HATA DÜZELTMESİ (kullanıcı bulundu -- Geomap widget'ında yanlış "SNMP"
-- etiketi fark edildi): npm-service'in SNMP poller'ı, bir cihazın GERÇEKTEN bir
-- SNMP interface'i olup olmadığına bakmadan (sadece placeholder olmayan bir
-- ip_address'i varsa) her cihazı SNMP ile yokluyordu. Bu, SNMP hiç
-- yapılandırılmamış cihazların (agent-tabanlı cihazlar, APM'den türeyen sahte
-- "servis" cihazları) yanlışlıkla 'down' + device_collector_status(snmp)='down'
-- olarak işaretlenmesine yol açtı -- cihaz listesinde yanlış kırmızı "SNMP"
-- rozeti ve Geomap widget'ında yanlış kırmızı pin olarak görünüyordu.
--
-- Kod tarafı düzeltmesi (services/npm/src/db.ts) artık sadece gerçekten bir
-- SNMP interface'i (veya eski snmp_config'i, veya netflow_only bayrağı) olan
-- cihazları yokluyor. Bu migration, bugünkü YANLIŞ duruma düşmüş (SNMP hiç
-- yapılandırılmamış ama snmp collector'ı 'down' görünen) cihazları temizliyor.

-- 1) SNMP interface'i (veya eski snmp_config'i) OLMAYAN cihazlar için sahte
--    snmp collector_status kayıtlarını sil.
DELETE FROM device_collector_status dcs
USING devices d
WHERE dcs.device_id = d.id
  AND dcs.collector_type = 'snmp'
  AND NOT EXISTS (SELECT 1 FROM device_interfaces di WHERE di.device_id = d.id AND di.interface_type = 'snmp')
  AND d.snmp_config IS NULL;

-- 2) Bu cihazlar (agent-tabanlı olup taze heartbeat'i olanlar VEYA hiç
--    izlenmeyen APM-türevi sahte "servis" cihazları) yanlışlıkla 'down' kaldıysa
--    -- ve başka HİÇBİR açık koleksiyoncu durumu 'down' demiyorsa -- 'active'e
--    geri alınıyor.
UPDATE devices d SET status = 'active'
WHERE d.status = 'down'
  AND NOT EXISTS (SELECT 1 FROM device_interfaces di WHERE di.device_id = d.id AND di.interface_type = 'snmp')
  AND d.snmp_config IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM device_collector_status dcs
    WHERE dcs.device_id = d.id AND dcs.status = 'down'
  );

-- 3) Sadece bu (artık düzeltilmiş) yanlış 'down' durumundan kaynaklanan açık
--    device_reachability (is_heartbeat) alarmlarını çöz.
UPDATE alerts a SET resolved_at = now()
FROM alert_rules r, devices d
WHERE a.rule_id = r.id
  AND r.device_id = d.id
  AND r.is_heartbeat = true
  AND a.metric_name = 'device_reachability'
  AND a.resolved_at IS NULL
  AND d.status = 'active';
