import { useQuery } from "@tanstack/react-query";
import { fetchMetrics, fetchMetricNames } from "../../api/metrics";

export function useMetricNames(deviceId: string) {
  return useQuery({
    queryKey: ["metric-names", deviceId],
    queryFn: () => fetchMetricNames(deviceId),
    enabled: !!deviceId
  });
}

export function useMetrics(deviceId: string, metricName?: string, hours = 6, iface?: string) {
  return useQuery({
    queryKey: ["metrics", deviceId, metricName, hours, iface],
    queryFn: () => fetchMetrics(deviceId, metricName, hours, iface),
    enabled: !!deviceId && !!metricName,
    refetchInterval: 30000
  });
}
