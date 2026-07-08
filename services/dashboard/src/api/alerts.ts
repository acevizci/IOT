import { apiFetch } from "./client";

export interface Alert {
  id: string;
  device_id: string;
  device_name: string | null;
  metric_name: string;
  triggered_at: string;
  resolved_at: string | null;
  severity: string;
  message: string;
}

export function fetchAlerts(status?: "open" | "resolved") {
  const qs = status ? `?status=${status}` : "";
  return apiFetch<Alert[]>(`/api/v1/alerts${qs}`);
}

export interface SuppressedAlert {
  id: string;
  message: string;
  suppressed_at: string;
  device_name: string;
  device_id: string;
  suppressed_metric: string;
  suppressing_metric: string;
}

export function fetchSuppressedAlerts() {
  return apiFetch<SuppressedAlert[]>("/api/v1/suppressed-alerts");
}
