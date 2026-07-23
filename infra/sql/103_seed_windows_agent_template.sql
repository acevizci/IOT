-- Metrik eksikliği taraması sırasında bulunan bir üretim/geri-yükleme riski:
-- bu ortamdaki "Windows by Zabbix agent" şablonu (agent'ın temel OS metrikleri +
-- bugün düzeltilen perfcounter item'ları) SADECE canlı veritabanında var --
-- hiçbir migration dosyasında tanımlı değil. Veritabanı sıfırdan kurulursa
-- (yeni kurulum / disaster recovery) bu şablon TAMAMEN kaybolur, Windows
-- cihazları izlemenin varsayılan bir yolu kalmaz.
--
-- Kapsam bilinçli olarak DAR tutuldu: bu ortamdaki diğer 48 şablonun çoğu
-- ya test amaçlı (DNS Test, Kafka Test, Windows PDH-WMI Test, Macro Test
-- Template gibi) ya da bu tesise özel elle düzenlenmiş varyantlar (Cisco IOS
-- by SNMP_Kenar_Switch, Saha_sw_Cisco Nexus 9000... gibi) -- bunları "genel"
-- birer şablonmuş gibi tüm tenant'lara tohumlamak yanlış olur. Sadece bugünkü
-- Agent metrik çalışmasıyla doğrudan ilgili, gerçekten jenerik/yeniden
-- kullanılabilir olan "Windows by Zabbix agent" şablonu tohumlanıyor.
DO $$
DECLARE
  t RECORD;
  tpl_id UUID;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    IF EXISTS (SELECT 1 FROM alert_templates WHERE tenant_id = t.id AND name = 'Windows by Zabbix agent') THEN
      CONTINUE;
    END IF;

    INSERT INTO alert_templates (tenant_id, name, device_type)
    VALUES (t.id, 'Windows by Zabbix agent', 'windows')
    RETURNING id INTO tpl_id;

    INSERT INTO template_items (template_id, metric_name, data_type, polling_interval_seconds, collector_type, connection_config) VALUES
      (tpl_id, 'cpu_util', 'gauge', 60, 'agent', '{}'),
      (tpl_id, 'memory_total_bytes', 'gauge', 60, 'agent', '{}'),
      (tpl_id, 'memory_used_percent', 'gauge', 60, 'agent', '{}'),
      (tpl_id, 'proc_num', 'gauge', 60, 'agent', '{}'),
      (tpl_id, 'system_swap_size_total', 'gauge', 60, 'agent', '{}'),
      (tpl_id, 'system_uptime', 'gauge', 60, 'agent', '{}'),
      (tpl_id, 'perf_counter_en___Memory_Cache_Bytes__', 'gauge', 60, 'agent',
        '{"path": "\\Memory\\Cache Bytes", "plugin": "perfcounter"}'),
      (tpl_id, 'perf_counter_en___Memory_Page_Faults_sec__', 'gauge', 60, 'agent',
        '{"path": "\\Memory\\Page Faults/sec", "plugin": "perfcounter"}'),
      (tpl_id, 'perf_counter_en___Memory_Pages_sec__', 'gauge', 60, 'agent',
        '{"path": "\\Memory\\Pages/sec", "plugin": "perfcounter"}'),
      (tpl_id, 'perf_counter_en___Memory_Pool_Nonpaged_Bytes__', 'gauge', 60, 'agent',
        '{"path": "\\Memory\\Pool Nonpaged Bytes", "plugin": "perfcounter"}'),
      (tpl_id, 'perf_counter_en___Paging_file__Total____Usage__', 'gauge', 60, 'agent',
        '{"path": "\\Paging file(_Total)\\% Usage", "plugin": "perfcounter"}'),
      -- GERÇEK HATA DÜZELTMESİ (bugün, RAM/disk/CPU/ethernet incelemesinde
      -- bulundu, bkz. 101_fix_windows_perfcounter_items.sql): bu şablon zaten
      -- modern "\Processor Information(_total)\..." kategorisini kullanıyordu --
      -- burada, o düzeltmeden SONRAKİ (doğru) haliyle tohumlanıyor, eski/hatalı
      -- "\Processor(_Total)\..." yolu HİÇ tekrar üretilmiyor.
      (tpl_id, 'perf_counter_en___Processor_Information__total____DPC_Time__', 'gauge', 60, 'agent',
        '{"path": "\\Processor Information(_total)\\% DPC Time", "plugin": "perfcounter"}'),
      (tpl_id, 'perf_counter_en___Processor_Information__total____Interrupt_', 'gauge', 60, 'agent',
        '{"path": "\\Processor Information(_total)\\% Interrupt Time", "plugin": "perfcounter"}'),
      (tpl_id, 'perf_counter_en___Processor_Information__total____Privileged', 'gauge', 60, 'agent',
        '{"path": "\\Processor Information(_total)\\% Privileged Time", "plugin": "perfcounter"}'),
      (tpl_id, 'perf_counter_en___Processor_Information__total____User_Time_', 'gauge', 60, 'agent',
        '{"path": "\\Processor Information(_total)\\% User Time", "plugin": "perfcounter"}'),
      (tpl_id, 'perf_counter_en___System_Context_Switches_sec__', 'gauge', 60, 'agent',
        '{"path": "\\System\\Context Switches/sec", "plugin": "perfcounter"}'),
      (tpl_id, 'perf_counter_en___System_Processor_Queue_Length__', 'gauge', 60, 'agent',
        '{"path": "\\System\\Processor Queue Length", "plugin": "perfcounter"}'),
      (tpl_id, 'perf_counter_en___System_Threads__', 'gauge', 60, 'agent',
        '{"path": "\\System\\Threads", "plugin": "perfcounter"}'),
      (tpl_id, 'wmi_get_root_cimv2__Select_NumberOfLogicalProcessors_from_Wi', 'gauge', 60, 'agent',
        '{"field": "NumberOfLogicalProcessors", "query": "Select NumberOfLogicalProcessors from Win32_ComputerSystem", "plugin": "wmi"}');
  END LOOP;
END $$;
