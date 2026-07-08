import { apiFetch } from "./client";

export interface DeviceAlertRule {
  id: string;
  metric_name: string;
  condition: "gt" | "lt" | "eq";
  threshold: number;
  duration_seconds: number;
  severity: string;
  active: boolean;
  from_template: boolean;
}

export function fetchDeviceRules(deviceId: string) {
  return apiFetch<DeviceAlertRule[]>(`/api/v1/devices/${deviceId}/alert-rules`);
}

export function createDeviceRule(deviceId: string, input: {
  metric_name: string;
  condition: "gt" | "lt" | "eq";
  threshold: number;
  duration_seconds: number;
  severity: string;
}) {
  return apiFetch<DeviceAlertRule>(`/api/v1/devices/${deviceId}/alert-rules`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteDeviceRule(ruleId: string) {
  return apiFetch<void>(`/api/v1/alert-rules/${ruleId}`, { method: "DELETE" });
}

export function toggleDeviceRule(ruleId: string, active: boolean) {
  return apiFetch<DeviceAlertRule>(`/api/v1/alert-rules/${ruleId}`, {
    method: "PATCH",
    body: JSON.stringify({ active })
  });
}
