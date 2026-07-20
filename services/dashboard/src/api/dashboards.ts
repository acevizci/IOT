import { apiFetch } from "./client";

export interface DashboardMeta {
  id: string;
  name: string;
  is_shared: boolean;
  is_default: boolean;
  owner_user_id: string;
  default_device_id: string | null;
  default_device_group_id: string | null;
  default_hours: number;
}

// Faz 9.5 — panonun üstündeki bağlam seçicisinin ("Bağlam:" çubuğu) o anki değeri.
// Widget'lar "Veri kaynağı: Pano" moduna geçtiğinde kendi config'i yerine bunu kullanır.
export interface DashboardContext {
  deviceId: string | null;
  deviceGroupId: string | null;
  hours: number;
}

export interface DashboardWidget {
  id: string;
  widget_type: "graph" | "problem_list" | "device_status" | "kpi_card" |
    "severity_distribution" | "problem_devices" | "top_n" | "platform_summary" |
    "service_health" | "escalation_history" | "maintenance_windows" |
    "device_card" | "status_badge" | "raw_table" | "note" | "clock" | "url" | "gauge" | "pie_chart" | "device_explorer" |
    "status_grid" | "web_monitoring_summary" | "host_performance_table" |
    "vmware_cluster_summary" | "vmware_datastore" | "vmware_vm_table";
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  title: string | null;
  config: Record<string, any>;
}

export interface BulkWidgetInput {
  id?: string;
  widget_type: DashboardWidget["widget_type"];
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  title?: string | null;
  config: Record<string, any>;
}

export function fetchDashboards() {
  return apiFetch<DashboardMeta[]>("/api/v1/dashboards");
}

export function createDashboard(input: { name: string; is_shared?: boolean }) {
  return apiFetch<DashboardMeta>("/api/v1/dashboards", { method: "POST", body: JSON.stringify(input) });
}

export function updateDashboard(
  id: string,
  input: Partial<{ name: string; is_shared: boolean; default_device_id: string | null; default_device_group_id: string | null; default_hours: number }>
) {
  return apiFetch<DashboardMeta>(`/api/v1/dashboards/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteDashboard(id: string) {
  return apiFetch<void>(`/api/v1/dashboards/${id}`, { method: "DELETE" });
}

export function fetchDashboardWidgets(dashboardId: string) {
  return apiFetch<DashboardWidget[]>(`/api/v1/dashboards/${dashboardId}/widgets`);
}

export function createWidget(dashboardId: string, input: Partial<DashboardWidget> & { widget_type: string }) {
  return apiFetch<DashboardWidget>(`/api/v1/dashboards/${dashboardId}/widgets`, { method: "POST", body: JSON.stringify(input) });
}

export function updateWidget(id: string, input: Partial<DashboardWidget>) {
  return apiFetch<DashboardWidget>(`/api/v1/dashboard-widgets/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteWidget(id: string) {
  return apiFetch<void>(`/api/v1/dashboard-widgets/${id}`, { method: "DELETE" });
}

export function bulkUpdateWidgets(dashboardId: string, widgets: BulkWidgetInput[]) {
  return apiFetch<DashboardWidget[]>(`/api/v1/dashboards/${dashboardId}/widgets`, {
    method: "PUT",
    body: JSON.stringify({ widgets })
  });
}

export function fetchKpiValue(source: string) {
  return apiFetch<{ value: number }>(`/api/v1/dashboard-kpi/${source}`);
}

export function fetchSeverityDistribution(deviceGroupId?: string) {
  const qs = deviceGroupId ? `?device_group_id=${deviceGroupId}` : "";
  return apiFetch<Array<{ severity: string; count: number }>>(`/api/v1/dashboard-widgets-data/severity-distribution${qs}`);
}

export function fetchProblemDevices(deviceGroupId?: string, limit = 10) {
  const params = new URLSearchParams();
  if (deviceGroupId) params.set("device_group_id", deviceGroupId);
  params.set("limit", String(limit));
  return apiFetch<Array<{ id: string; name: string; alert_count: number; max_severity: string }>>(`/api/v1/dashboard-widgets-data/problem-devices?${params}`);
}

export function fetchTopN(metricName: string, deviceGroupId?: string, limit = 5, order: "asc" | "desc" = "desc") {
  const params = new URLSearchParams({ metric_name: metricName, limit: String(limit), order });
  if (deviceGroupId) params.set("device_group_id", deviceGroupId);
  return apiFetch<Array<{ id: string; name: string; value: number; time: string }>>(`/api/v1/dashboard-widgets-data/top-n?${params}`);
}

export function fetchServiceHealth(scenarioId: string) {
  return apiFetch<{ scenario_name: string; steps: Array<{ step_name: string; status: number | null; latency_ms: number | null; last_check: string | null }> }>(`/api/v1/dashboard-widgets-data/service-health/${scenarioId}`);
}

export function fetchEscalationHistory(limit = 10) {
  return apiFetch<Array<{ id: string; metric_name: string; last_escalation_step: number; triggered_at: string; device_name: string }>>(`/api/v1/dashboard-widgets-data/escalation-history?limit=${limit}`);
}

export function fetchPlatformSummary() {
  return apiFetch<{
    device_count: number;
    device_active: number;
    device_down: number;
    template_count: number;
    active_rule_count: number;
    rule_count: number;
    inactive_rule_count: number;
    open_alert_count: number;
    active_metric_count: number;
    user_count: number;
    metrics_per_second: number;
  }>(`/api/v1/dashboard-widgets-data/platform-summary`);
}

export function fetchMaintenanceWindowsWidget() {
  return apiFetch<Array<{ id: string; name: string; starts_at: string; ends_at: string; is_active: boolean }>>(`/api/v1/dashboard-widgets-data/maintenance-windows`);
}

export function fetchDeviceCard(deviceId: string) {
  return apiFetch<{ id: string; name: string; ip_address: string; device_type: string; vendor: string; status: string; open_alert_count: number; templates: string[] }>(`/api/v1/dashboard-widgets-data/device-card/${deviceId}`);
}

export function fetchStatusBadge(deviceId: string, metricName: string) {
  return apiFetch<{ value: number | null; label: string | null; time: string | null }>(`/api/v1/dashboard-widgets-data/status-badge?device_id=${deviceId}&metric_name=${metricName}`);
}

export function fetchRawTable(deviceId: string, metricName: string) {
  return apiFetch<Array<{ interface: string; value: number; time: string }>>(`/api/v1/dashboard-widgets-data/raw-table?device_id=${deviceId}&metric_name=${metricName}`);
}

// Faz 10.6 — Durum Izgarası: bir metriğin tüm cihazlardaki (opsiyonel host grubu
// filtreli) en son değerleri.
export function fetchStatusGrid(metricName: string, deviceGroupId?: string) {
  const params = new URLSearchParams({ metric_name: metricName });
  if (deviceGroupId) params.set("device_group_id", deviceGroupId);
  return apiFetch<Array<{ id: string; name: string; value: number; time: string }>>(`/api/v1/dashboard-widgets-data/status-grid?${params}`);
}

// Faz 10.3 — Web İzleme Özeti: tüm web senaryolarının Ok/Failed/Unknown dökümü.
export function fetchWebMonitoringSummary() {
  return apiFetch<Array<{ scenario_id: string; scenario_name: string; ok_count: number; failed_count: number; unknown_count: number }>>(
    `/api/v1/dashboard-widgets-data/web-monitoring-summary`
  );
}

// Faz 10.7 — Host Performans Tablosu: birden fazla cihazın birden fazla metriğinin
// sparkline verisi + en son değeri.
export function fetchHostPerformanceTable(metrics: string[], deviceGroupId?: string, sparklinePoints = 20) {
  const params = new URLSearchParams({ metrics: metrics.join(","), sparkline_points: String(sparklinePoints) });
  if (deviceGroupId) params.set("device_group_id", deviceGroupId);
  return apiFetch<
    Array<{
      device_id: string;
      device_name: string;
      series: Record<string, Array<{ time: string; value: number }>>;
      latest: Record<string, number | null>;
    }>
  >(`/api/v1/dashboard-widgets-data/host-performance-table?${params}`);
}

// FAZ J — VMware widget'ları. Cluster/Datastore metrikleri hâlâ vCenter cihazının
// KENDİ device_id'sinde (host hiyerarşi düzeltmesi bunları taşımadı) -- tek cihaz sorgusu.
export function fetchVMwareInstanceSummary(deviceId: string, metrics: string[]) {
  const params = new URLSearchParams({ device_id: deviceId, metrics: metrics.join(",") });
  return apiFetch<Array<{ instance_label: string; values: Record<string, number> }>>(
    `/api/v1/dashboard-widgets-data/vmware-instance-summary?${params}`
  );
}

// VM metrikleri artık HOST cihazlarının device_id'sinde (host hiyerarşi düzeltmesi
// sonrası) -- bu yüzden device_group_id bazlı (o vCenter'ın "Tüm Host'lar" grubu).
export function fetchVMwareVMTable(deviceGroupId: string, metrics: string[]) {
  const params = new URLSearchParams({ device_group_id: deviceGroupId, metrics: metrics.join(",") });
  return apiFetch<Array<{ device_id: string; device_name: string; instance_label: string; values: Record<string, number> }>>(
    `/api/v1/dashboard-widgets-data/vmware-vm-table?${params}`
  );
}
