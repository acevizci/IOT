-- Düzeltme: 105_template_library_cleanup.sql'deki cihaz ataması düzeltmesi
-- Core-Switch-01'i YANLIŞ tenant'ta (b2dbf6ab) aradı -- gerçekte b64624e9
-- tenant'ına ait, bu yüzden hiç şablon atanmadan sessizce atlandı.
INSERT INTO device_templates (device_id, template_id)
SELECT d.id, at.id
FROM devices d
JOIN alert_templates at ON at.tenant_id = d.tenant_id AND at.name = 'Cisco Switch/Router (SNMP)'
WHERE d.name = 'Core-Switch-01'
ON CONFLICT DO NOTHING;
