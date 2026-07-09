import { apiFetch } from "./client";

export interface MaintenanceWindow {
  id: string;
  name: string;
  starts_at: string;
  ends_at: string;
  created_at: string;
  is_active: boolean;
  device_count: number;
  group_count: number;
}

export interface MaintenanceWindowDetail extends MaintenanceWindow {
  devices: Array<{ id: string; name: string }>;
  groups: Array<{ id: string; name: string }>;
}

export function fetchMaintenanceWindows() {
  return apiFetch<MaintenanceWindow[]>("/api/v1/maintenance-windows");
}

export function fetchMaintenanceWindow(id: string) {
  return apiFetch<MaintenanceWindowDetail>(`/api/v1/maintenance-windows/${id}`);
}

export function createMaintenanceWindow(input: {
  name: string;
  starts_at: string;
  ends_at: string;
  device_ids?: string[];
  device_group_ids?: string[];
}) {
  return apiFetch<MaintenanceWindow>("/api/v1/maintenance-windows", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteMaintenanceWindow(id: string) {
  return apiFetch<void>(`/api/v1/maintenance-windows/${id}`, { method: "DELETE" });
}

export function fetchGroupMaintenanceWindows(groupId: string) {
  return apiFetch<MaintenanceWindow[]>(`/api/v1/device-groups/${groupId}/maintenance-windows`);
}
