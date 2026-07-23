-- RAM/Disk/CPU/Ethernet incelemesi: Windows perf-counter şablon item'larında
-- iki gerçek düzeltme.
--
-- 1) win_cpu_percent, eski/güvenilmez "\Processor(_Total)\% Processor Time"
--    kategorisini kullanıyordu -- AYNI şablondaki diğer dört CPU alt-metriği
--    (DPC/Interrupt/Privileged/User Time) zaten Microsoft'un önerdiği modern
--    "\Processor Information(_total)\..." kategorisini kullanıyordu, sadece
--    bu biri tutarsızdı. Modern kategoriye taşındı.
UPDATE template_items
SET connection_config = jsonb_set(connection_config, '{path}', '"\\Processor Information(_total)\\% Processor Time"')
WHERE connection_config->>'plugin' = 'perfcounter'
  AND connection_config->>'path' = '\Processor(_Total)\% Processor Time';

-- 2) "Free System Page Table Entries" -- 64-bit Windows'ta bu sayaç artık
--    anlamsız (PTE, 32-bit'teki gibi kısıtlı bir kaynak değil), Microsoft'un
--    kendi belgelediği gibi neredeyse sabit, 2^32'ye yakın bir değer
--    döndürüyor. Gerçek veride doğrulandı (~4.29 milyar, hep aynı civarda).
--    Endüstri standardı (Zabbix'in kendi şablon geçmişi) bu sayacı modern
--    Windows şablonlarından çıkarır -- biz de aynısını yapıyoruz.
DELETE FROM template_items
WHERE connection_config->>'plugin' = 'perfcounter'
  AND connection_config->>'path' = '\Memory\Free System Page Table Entries';
