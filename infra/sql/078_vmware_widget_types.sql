-- FAZ J — VMware dashboard widget'ları için dashboard_widgets.widget_type CHECK
-- constraint'ine 3 yeni değer ekleniyor. Zod şemasını (core/src/index.ts) daha önce
-- güncellemiştim ama bu DB-seviyesi CHECK constraint'i UNUTMUŞUM -- canlıda "500
-- Internal Server Error" ile yakalandı (Zod validasyonu geçti ama INSERT/UPDATE
-- Postgres'in kendi CHECK'ine takıldı).
ALTER TABLE dashboard_widgets DROP CONSTRAINT IF EXISTS dashboard_widgets_widget_type_check;
ALTER TABLE dashboard_widgets ADD CONSTRAINT dashboard_widgets_widget_type_check
  CHECK (widget_type = ANY (ARRAY[
    'graph'::text, 'problem_list'::text, 'device_status'::text, 'kpi_card'::text,
    'severity_distribution'::text, 'problem_devices'::text, 'top_n'::text, 'platform_summary'::text,
    'service_health'::text, 'escalation_history'::text, 'maintenance_windows'::text,
    'device_card'::text, 'status_badge'::text, 'raw_table'::text, 'note'::text, 'clock'::text,
    'url'::text, 'gauge'::text, 'pie_chart'::text, 'device_explorer'::text, 'status_grid'::text,
    'web_monitoring_summary'::text, 'host_performance_table'::text,
    'vmware_cluster_summary'::text, 'vmware_datastore'::text, 'vmware_vm_table'::text
  ]));
