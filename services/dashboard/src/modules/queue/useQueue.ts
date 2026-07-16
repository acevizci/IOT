import { useQuery } from "@tanstack/react-query";
import { fetchQueueOverview, fetchQueueDetails } from "../../api/queue";

export function useQueueOverview() {
  return useQuery({
    queryKey: ["queue-overview"],
    queryFn: fetchQueueOverview,
    refetchInterval: 15000
  });
}

export function useQueueDetails(collectorType?: string, deviceId?: string) {
  return useQuery({
    queryKey: ["queue-details", collectorType, deviceId],
    queryFn: () => fetchQueueDetails(collectorType, deviceId),
    enabled: !!collectorType || !!deviceId,
    refetchInterval: 15000
  });
}
