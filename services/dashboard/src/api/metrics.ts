import { apiFetch } from "./client";

export interface MetricPoint {
  time: string;
  metric_name: string;
  interface: string | null;
  value: number;
}

export interface MetricNameEntry {
  metric_name: string;
  interface: string | null;
}

export function fetchMetrics(deviceId: string, metricName?: string, hours = 6, iface?: string) {
  const query = new URLSearchParams({ device_id: deviceId, hours: String(hours) });
  if (metricName) query.set("metric_name", metricName);
  if (iface) query.set("interface", iface);
  return apiFetch<{ source: string; rows: MetricPoint[] }>(`/api/v1/metrics?${query.toString()}`);
}

export function fetchMetricNames(deviceId: string) {
  return apiFetch<MetricNameEntry[]>(`/api/v1/metrics/names?device_id=${deviceId}`);
}
