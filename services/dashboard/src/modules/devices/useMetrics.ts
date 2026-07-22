import { useQuery } from "@tanstack/react-query";
import { fetchMetrics, fetchMetricNames, fetchMetricNamesSummary } from "../../api/metrics";

export function useMetricNames(deviceId: string) {
  return useQuery({
    queryKey: ["metric-names", deviceId],
    queryFn: () => fetchMetricNames(deviceId),
    enabled: !!deviceId
  });
}

// Bir cihaza değil bir host grubuna (ya da hiç grup verilmezse tüm cihazlara)
// göre çalışan widget'lar için -- her zaman etkin (device_group_id boş olsa
// bile "tüm cihazlardaki metrikler" anlamlı bir sorgu).
export function useMetricNamesSummary(deviceGroupId?: string) {
  return useQuery({
    queryKey: ["metric-names-summary", deviceGroupId],
    queryFn: () => fetchMetricNamesSummary(deviceGroupId)
  });
}

export function useMetrics(deviceId: string, metricName?: string, hours = 6, iface?: string, range?: { from: string; to: string }) {
  return useQuery({
    queryKey: ["metrics", deviceId, metricName, hours, iface, range],
    queryFn: () => fetchMetrics(deviceId, metricName, hours, iface, range),
    enabled: !!deviceId && !!metricName,
    refetchInterval: range ? false : 30000
  });
}
