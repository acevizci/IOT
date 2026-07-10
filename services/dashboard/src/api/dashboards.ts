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
  widget_type: "graph" | "problem_list" | "device_status" | "kpi_card";
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
