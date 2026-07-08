import { useQuery } from "@tanstack/react-query";
import { fetchTopTalkers, fetchTrafficSummary, fetchProtocolBreakdown } from "../../api/traffic";

export function useTopTalkers(hours: number) {
  return useQuery({
    queryKey: ["top-talkers", hours],
    queryFn: () => fetchTopTalkers(hours),
    refetchInterval: 15000
  });
}

export function useTrafficSummary(hours: number) {
  return useQuery({
    queryKey: ["traffic-summary", hours],
    queryFn: () => fetchTrafficSummary(hours),
    refetchInterval: 15000
  });
}

export function useProtocolBreakdown(hours: number) {
  return useQuery({
    queryKey: ["protocol-breakdown", hours],
    queryFn: () => fetchProtocolBreakdown(hours),
    refetchInterval: 15000
  });
}
