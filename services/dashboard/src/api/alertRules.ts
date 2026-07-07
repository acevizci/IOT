import { apiFetch } from "./client";

export interface AlertRule {
  id: string;
  metric_name: string;
  condition: "gt" | "lt" | "eq";
  threshold: number;
  duration_seconds: number;
  device_id: string | null;
  device_name: string | null;
  active: boolean;
}

export function fetchAlertRules() {
  return apiFetch<AlertRule[]>("/api/v1/alert-rules");
}

export function createAlertRule(input: {
  metric_name: string;
  condition: "gt" | "lt" | "eq";
  threshold: number;
  duration_seconds: number;
  device_id?: string | null;
}) {
  return apiFetch<AlertRule>("/api/v1/alert-rules", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateAlertRule(id: string, input: Partial<Pick<AlertRule, "active" | "threshold" | "duration_seconds">>) {
  return apiFetch<AlertRule>(`/api/v1/alert-rules/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function deleteAlertRule(id: string) {
  return apiFetch<void>(`/api/v1/alert-rules/${id}`, { method: "DELETE" });
}
