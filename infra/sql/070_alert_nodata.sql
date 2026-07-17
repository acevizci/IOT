-- KAPSAM GENİŞLETMESİ: metrik-seviyesinde "nodata" izleme (bkz. DENETIM_RAPORU.md §4).
-- Önceden: bir cihaz erişilebilir durumdayken (device_reachability/agent heartbeat
-- normal), ama TEK BİR metrik (örn. belirli bir SNMP OID/interface sayacı) raporlanmayı
-- durdurursa, o kural için örnek sayısı MIN_SAMPLES_REQUIRED'in altına düşer ve
-- evaluateRuleForDevice() sessizce hiçbir şey yapmadan geri dönerdi -- hiçbir alarm
-- tetiklenmezdi. Bu kolon, "eşik aşıldı" alarmlarını "veri hiç gelmiyor" alarmlarından
-- ayırt etmek için kullanılıyor (aynı rule_id+device_id slotunu paylaşırlar, ikisi
-- aynı anda açık olamaz zaten -- biri veri yokluğunu, diğeri eşik ihlalini temsil eder).
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS is_nodata BOOLEAN NOT NULL DEFAULT false;
