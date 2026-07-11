ALTER TABLE dashboard_widgets DROP CONSTRAINT dashboard_widgets_widget_type_check;
ALTER TABLE dashboard_widgets ADD CONSTRAINT dashboard_widgets_widget_type_check
  CHECK (widget_type = ANY (ARRAY[
    'graph', 'problem_list', 'device_status', 'kpi_card',
    'severity_distribution', 'problem_devices', 'top_n', 'platform_summary',
    'service_health', 'escalation_history', 'maintenance_windows',
    'device_card', 'status_badge', 'raw_table', 'note', 'clock', 'url', 'gauge', 'pie_chart'
  ]));
