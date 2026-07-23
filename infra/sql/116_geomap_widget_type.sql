-- Kullanıcı isteği: Coğrafi Harita, Zabbix'teki "Geomap" widget'ı gibi panoya
-- eklenebilen bir widget olmalı (ayrı bir sayfa olarak DEĞİL, ya da onunla birlikte).
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
    'trap_log'::text, 'syslog_log'::text, 'predictive_forecast'::text, 'alert_trend'::text,
    'geomap'::text
  ]));
