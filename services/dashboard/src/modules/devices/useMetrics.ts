import { useQuery } from "@tanstack/react-query";
import { fetchMetrics, fetchMetricNames } from "../../api/metrics";

export function useMetricNames(deviceId: string) {
  return useQuery({
    queryKey: ["metric-names", deviceId],
    queryFn: () => fetchMetricNames(deviceId),
    enabled: !!deviceId
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
