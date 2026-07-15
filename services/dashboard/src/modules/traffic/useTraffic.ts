import { useQuery } from "@tanstack/react-query";
import { fetchTopTalkers, fetchTrafficSummary, fetchProtocolBreakdown } from "../../api/traffic";

export function useTopTalkers(hours: number, deviceId?: string) {
  return useQuery({
    queryKey: ["top-talkers", hours, deviceId],
    queryFn: () => fetchTopTalkers(hours, 20, deviceId),
    refetchInterval: 15000
  });
}
export function useTrafficSummary(hours: number, deviceId?: string) {
  return useQuery({
    queryKey: ["traffic-summary", hours, deviceId],
    queryFn: () => fetchTrafficSummary(hours, deviceId),
    refetchInterval: 15000
  });
}
export function useProtocolBreakdown(hours: number, deviceId?: string) {
  return useQuery({
    queryKey: ["protocol-breakdown", hours, deviceId],
    queryFn: () => fetchProtocolBreakdown(hours, deviceId),
    refetchInterval: 15000
  });
}
