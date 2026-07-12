import { apiFetch } from "./client";

export interface CollectorStatus {
  collector_type: string;
  status: "unknown" | "active" | "down";
  last_error: string | null;
}

export interface Device {
  id: string;
  name: string;
  ip_address: string;
  device_type: string;
  vendor: string | null;
  location: string | null;
  status: string;
  attributes?: { tags?: string[]; [key: string]: any };
  created_at: string;
  enabled?: boolean;
  tags?: Array<{ tag: string; value: string }>;
  item_count?: number;
  rule_count?: number;
  template_names?: string[];
  collector_statuses?: CollectorStatus[];
}

export interface DeviceListParams {
  page?: number;
  limit?: number;
  status?: string;
  device_type?: string;
  search?: string;
  tag?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export function fetchDevices(params: DeviceListParams = {}) {
  const query = new URLSearchParams();
  if (params.page) query.set("page", String(params.page));
  if (params.limit) query.set("limit", String(params.limit));
  if (params.status) query.set("status", params.status);
  if (params.device_type) query.set("device_type", params.device_type);
  if (params.search) query.set("search", params.search);
  if (params.tag) query.set("tag", params.tag);
  const qs = query.toString();
  return apiFetch<PaginatedResult<Device>>(`/api/v1/devices${qs ? `?${qs}` : ""}`);
}

export interface DeviceFacets {
  device_types: string[];
  statuses: string[];
}

export function fetchDeviceFacets() {
  return apiFetch<DeviceFacets>("/api/v1/devices/facets");
}

export function fetchDeviceTags() {
  return apiFetch<string[]>("/api/v1/devices/tags");
}

export function fetchDevice(id: string) {
  return apiFetch<Device>(`/api/v1/devices/${id}`);
}

export interface DeviceInterfaceInput {
  interface_type: "snmp" | "ssh" | "sql" | "web";
  ip_address?: string;
  port?: number;
  snmp_community?: string;
}

export function createDevice(input: {
  name: string;
  ip_address?: string;
  device_type: string;
  vendor?: string;
  location?: string;
  tags?: string[];
  attributes?: Record<string, any>;
  interfaces?: DeviceInterfaceInput[];
  device_group_id?: string;
}) {
  return apiFetch<Device>("/api/v1/devices", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateDevice(id: string, input: Partial<{ name: string; vendor: string; location: string; tags: string[]; attributes: Record<string, any>; enabled: boolean }>) {
  return apiFetch<Device>(`/api/v1/devices/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function deleteDevice(id: string) {
  return apiFetch<void>(`/api/v1/devices/${id}`, { method: "DELETE" });
}

export function bulkDeleteDevices(ids: string[]) {
  return apiFetch<{ deleted: number }>("/api/v1/devices/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ ids })
  });
}

export interface LatestDataPoint {
  metric_name: string;
  interface: string | null;
  value: number;
  unit: string | null;
  time: string;
}

export function fetchLatestData(deviceId: string) {
  return apiFetch<LatestDataPoint[]>(`/api/v1/devices/${deviceId}/latest-data`);
}

export interface DeviceTemplate {
  id: string;
  name: string;
}

export function fetchDeviceTemplates(deviceId: string) {
  return apiFetch<DeviceTemplate[]>(`/api/v1/devices/${deviceId}/templates`);
}

export function assignDeviceTemplate(deviceId: string, templateId: string) {
  return apiFetch<{ device_id: string; template_id: string }>(`/api/v1/devices/${deviceId}/templates`, {
    method: "POST",
    body: JSON.stringify({ template_id: templateId })
  });
}

export function removeDeviceTemplate(deviceId: string, templateId: string) {
  return apiFetch<void>(`/api/v1/devices/${deviceId}/templates/${templateId}`, { method: "DELETE" });
}

export interface DeviceAlertSummary {
  id: string;
  metric_name: string;
  condition: string;
  threshold: number | null;
  value: number | null;
  severity: string;
  message: string;
  triggered_at: string;
  resolved_at: string | null;
  acknowledged_at: string | null;
}

export interface DeviceChangeSummary {
  id: string;
  user_email: string;
  method: string;
  path: string;
  status_code: number;
  created_at: string;
}

export interface TopologyNeighbor {
  id: string;
  name: string;
  open_alert_message: string | null;
  open_alert_triggered_at: string | null;
  open_alert_severity: string | null;
  likely_root_cause: boolean;
}

export interface ConcurrentIncident {
  id: string;
  device_id: string;
  device_name: string;
  message: string;
  severity: string;
  triggered_at: string;
}

export interface DeviceDiagnostics {
  recent_alerts: DeviceAlertSummary[];
  recent_changes: DeviceChangeSummary[];
  topology_neighbors: TopologyNeighbor[];
  concurrent_incidents: ConcurrentIncident[];
  anchor_time: string | null;
}

export function fetchDeviceDiagnostics(deviceId: string) {
  return apiFetch<DeviceDiagnostics>(`/api/v1/devices/${deviceId}/diagnostics`);
}

export function bulkAssignGroup(deviceIds: string[], deviceGroupId: string) {
  return apiFetch<{ added: number }>("/api/v1/devices/bulk-assign-group", {
    method: "POST",
    body: JSON.stringify({ device_ids: deviceIds, device_group_id: deviceGroupId })
  });
}

export function bulkAssignTemplate(deviceIds: string[], templateId: string) {
  return apiFetch<{ assigned: number }>("/api/v1/devices/bulk-assign-template", {
    method: "POST",
    body: JSON.stringify({ device_ids: deviceIds, template_id: templateId })
  });
}

export interface NeededCollectorTypeMacro {
  macro_id: string;
  key: string;
  value_type: "numeric" | "string" | "secret";
  has_device_override: boolean;
  current_value: string | null;
}

export interface NeededCollectorType {
  collector_type: string;
  display_name: string;
  is_configured: boolean;
  macros: NeededCollectorTypeMacro[];
}

export function fetchNeededCollectorTypes(deviceId: string) {
  return apiFetch<NeededCollectorType[]>(`/api/v1/devices/${deviceId}/needed-collector-types`);
}

export interface UsedMacro {
  key: string;
  macro_id: string | null;
  description: string | null;
  value_type: string;
  resolved_value: string | null;
  has_device_override: boolean;
  exists: boolean;
}

export function fetchDeviceUsedMacros(deviceId: string) {
  return apiFetch<UsedMacro[]>(`/api/v1/devices/${deviceId}/used-macros`);
}

export function assignDeviceToGroup(groupId: string, deviceId: string) {
  return apiFetch<void>(`/api/v1/device-groups/${groupId}/members`, {
    method: "POST",
    body: JSON.stringify({ device_ids: [deviceId] })
  });
}
