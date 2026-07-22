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
  // template_items.unit (varsa), yoksa metrics.unit'e geri düşer (bkz. core
  // /api/v1/metrics/names) -- "percent"/"ms"/"bytes" gibi ham bir birim string'i,
  // Y ekseninde/rozette gösterilmek üzere.
  unit: string | null;
}

export type MetricDrawStyle = "line" | "points" | "staircase";
export type MetricYAxis = "left" | "right";

// Faz 9.2 — Grafik widget'ında birden fazla metrik seçilebilmesi için: her seçili
// metriğin adı + (varsa) sabit rengi.
// Kullanıcı isteği (Zabbix'in gelişmiş grafik editörüyle AYNI fikir): her seri
// kendi çizim stilini (çizgi/nokta/basamak), kalınlığını, dolgu şeffaflığını ve
// hangi Y eksenine (sol/sağ) bağlı olduğunu taşıyabilir -- örn. "%" ile "GB"
// gibi farklı ölçekteki iki metrik aynı grafikte okunur şekilde gösterilebilir.
export interface MetricSelection {
  metric_name: string;
  color?: string;
  drawStyle?: MetricDrawStyle;
  width?: number;
  fillOpacity?: number;
  yAxis?: MetricYAxis;
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

// Bir cihaza değil bir host grubuna (ya da hiç grup verilmezse tüm cihazlara)
// göre çalışan widget'lar (top_n/status_grid/host_performance_table) için --
// TEK bir cihaz olmadığından fetchMetricNames kullanılamaz.
export function fetchMetricNamesSummary(deviceGroupId?: string) {
  const qs = deviceGroupId ? `?device_group_id=${deviceGroupId}` : "";
  return apiFetch<string[]>(`/api/v1/metrics/names-summary${qs}`);
}
