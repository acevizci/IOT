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
  // Kural-bazlı sigma override (null = global varsayılan, genelde 3) ve opt-in
  // saatlik mevsimsel baseline.
  anomaly_sigma: number | null;
  anomaly_seasonal: boolean;
  // Predictive Analytics opt-out + kural başına tahmin ufku (saat) -- varsayılan
  // enabled=true, horizon=24 (backend'de aynı varsayılan).
  predictive_enabled: boolean;
  predictive_horizon_hours: number;
  // Eskalasyon politikası (bkz. escalationPolicies.ts) -- null = eskalasyon yok.
  escalation_policy_id: string | null;
  escalation_policy_name: string | null;
  // Flapping bastırma opt-out: varsayılan true (otomatik) -- kural son
  // flapping_window_seconds içinde flapping_threshold_count kez veya daha fazla
  // tetiklenirse, alarm yine açılır/çözülür ama bildirim gönderilmez.
  flapping_enabled: boolean;
  flapping_threshold_count: number;
  flapping_window_seconds: number;
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

export function setRuleAnomalyDetection(ruleId: string, input: { enabled?: boolean; sigma?: number | null; seasonal?: boolean }) {
  return apiFetch<{ id: string; anomaly_enabled: boolean; anomaly_sigma: number | null; anomaly_seasonal: boolean }>(
    `/api/v1/alert-rules/${ruleId}/anomaly-detection`,
    { method: "PATCH", body: JSON.stringify(input) }
  );
}

export function setRulePredictiveAnalytics(ruleId: string, input: { enabled?: boolean; horizon_hours?: number }) {
  return apiFetch<{ id: string; predictive_enabled: boolean; predictive_horizon_hours: number }>(
    `/api/v1/alert-rules/${ruleId}/predictive-analytics`,
    { method: "PATCH", body: JSON.stringify(input) }
  );
}

export function setRuleFlappingSuppression(ruleId: string, input: { enabled?: boolean; threshold_count?: number; window_seconds?: number }) {
  return apiFetch<{ id: string; flapping_enabled: boolean; flapping_threshold_count: number; flapping_window_seconds: number }>(
    `/api/v1/alert-rules/${ruleId}/flapping-suppression`,
    { method: "PATCH", body: JSON.stringify(input) }
  );
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
