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
  // Anomali Tespiti opt-out: varsayılan true (otomatik), kullanıcı kapatabilir.
  anomaly_enabled: boolean;
}

export interface RuleDependency {
  depends_on_rule_id: string;
  metric_name: string;
  condition: "gt" | "lt" | "eq";
  threshold: number;
}

export function fetchDeviceRules(deviceId: string) {
  return apiFetch<DeviceAlertRule[]>(`/api/v1/devices/${deviceId}/alert-rules`);
}

export function setRuleAnomalyDetection(ruleId: string, enabled: boolean) {
  return apiFetch<{ id: string; anomaly_enabled: boolean }>(`/api/v1/alert-rules/${ruleId}/anomaly-detection`, {
    method: "PATCH",
    body: JSON.stringify({ enabled })
  });
}

export function fetchRuleDependencies(ruleId: string) {
  return apiFetch<RuleDependency[]>(`/api/v1/alert-rules/${ruleId}/dependencies`);
}

export function setRuleDependency(ruleId: string, dependsOnRuleId: string) {
  return apiFetch<{ rule_id: string; depends_on_rule_id: string }>(`/api/v1/alert-rules/${ruleId}/dependencies`, {
    method: "POST",
    body: JSON.stringify({ depends_on_rule_id: dependsOnRuleId })
  });
}

export function removeRuleDependency(ruleId: string, dependsOnRuleId: string) {
  return apiFetch<void>(`/api/v1/alert-rules/${ruleId}/dependencies/${dependsOnRuleId}`, { method: "DELETE" });
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
