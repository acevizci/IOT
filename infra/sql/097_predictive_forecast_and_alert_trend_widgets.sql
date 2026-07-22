-- Kullanıcı önerisi: iki yeni dashboard widget'ı.
-- 1) predictive_forecast: Tahminsel Analiz'in (predictiveAnalytics.ts) ürettiği
--    is_predictive alarmları "eşiğe kalan süreye" göre sıralı gösterir --
--    Zabbix/Datadog'daki "capacity forecast" panelleriyle AYNI fikir.
--    "Kaç saat kaldı" önceden SADECE alerts.message metnine gömülüydü (ham
--    string, sıralanamaz) -- artık yapılandırılmış bir kolonda.
-- 2) alert_trend: severity başına, zaman içinde alarm SAYISI (Zabbix'in
--    "Problems by severity" zaman-serisi grafiği, Datadog/Grafana'nın "problems
--    over time" panelleriyle AYNI fikir) -- şu an sadece ANLIK dağılım
--    (severity_distribution widget'ı) var, zaman içindeki TREND yok.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS predicted_hours_to_breach NUMERIC;

ALTER TABLE dashboard_widgets DROP CONSTRAINT IF EXISTS dashboard_widgets_widget_type_check;
ALTER TABLE dashboard_widgets ADD CONSTRAINT dashboard_widgets_widget_type_check
  CHECK (widget_type = ANY (ARRAY[
    'graph'::text, 'problem_list'::text, 'device_status'::text, 'kpi_card'::text,
    'severity_distribution'::text, 'problem_devices'::text, 'top_n'::text, 'platform_summary'::text,
    'service_health'::text, 'escalation_history'::text, 'maintenance_windows'::text,
    'device_card'::text, 'status_badge'::text, 'raw_table'::text, 'note'::text, 'clock'::text,
    'url'::text, 'gauge'::text, 'pie_chart'::text, 'device_explorer'::text, 'status_grid'::text,
    'web_monitoring_summary'::text, 'host_performance_table'::text,
    'vmware_cluster_summary'::text, 'vmware_datastore'::text, 'vmware_vm_table'::text,
    'trap_log'::text, 'syslog_log'::text, 'predictive_forecast'::text, 'alert_trend'::text
  ]));
