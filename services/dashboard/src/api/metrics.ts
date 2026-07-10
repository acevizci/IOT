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
  data_type: "gauge" | "counter" | "string";
  is_table: boolean;
  value_map_id: string | null;
}

// Faz 9.2 — Grafik widget'ında birden fazla metrik seçilebilmesi için: her seçili
// metriğin adı + (varsa) sabit rengi.
export interface MetricSelection {
  metric_name: string;
  color?: string;
}

export function fetchMetrics(deviceId: string, metricName?: string, hours = 6, iface?: string, range?: { from: string; to: string }) {
  const query = new URLSearchParams({ device_id: deviceId });
  if (range) {
    query.set("from", range.from);
    query.set("to", range.to);
  } else {
    query.set("hours", String(hours));
  }
  if (metricName) query.set("metric_name", metricName);
  if (iface) query.set("interface", iface);
  return apiFetch<{ source: string; rows: MetricPoint[] }>(`/api/v1/metrics?${query.toString()}`);
}

export function fetchMetricNames(deviceId: string) {
  return apiFetch<MetricNameEntry[]>(`/api/v1/metrics/names?device_id=${deviceId}`);
}
