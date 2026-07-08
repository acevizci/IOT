import { apiFetch } from "./client";

export interface DeviceRelations {
  device_groups: Array<{ id: string; name: string }>;
  templates: Array<{ id: string; name: string; item_count: number; rule_count: number }>;
  alert_rules: Array<{ id: string; metric_name: string; condition: string; threshold: number; duration_seconds: number; severity: string; from_template: boolean; depends_on_metric_name: string | null }>;
  notification_targets: Array<{ destination: string; min_severity: string; media_type: string }>;
  active_maintenance: Array<{ id: string; name: string; starts_at: string; ends_at: string }>;
}

export function fetchDeviceRelations(deviceId: string) {
  return apiFetch<DeviceRelations>(`/api/v1/devices/${deviceId}/relations`);
}

export interface AppliedTemplate {
  id: string;
  name: string;
  applied_device_count: number;
}

export function fetchGroupAppliedTemplates(groupId: string) {
  return apiFetch<AppliedTemplate[]>(`/api/v1/device-groups/${groupId}/applied-templates`);
}
