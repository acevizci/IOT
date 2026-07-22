import { useQuery } from "@tanstack/react-query";
import { fetchApmServices, fetchApmTraces, fetchApmTraceDetail, type ApmServicesParams, type ApmTracesParams } from "../../api/apm";

export function useApmServices(params: ApmServicesParams) {
  return useQuery({
    queryKey: ["apm-services", params],
    queryFn: () => fetchApmServices(params),
    refetchInterval: 10000 // canlı üretici sürekli veri ürettiği için otomatik yenileme
  });
}

export function useApmTraces(params: ApmTracesParams) {
  return useQuery({
    queryKey: ["apm-traces", params],
    queryFn: () => fetchApmTraces(params),
    refetchInterval: 10000
  });
}

export function useApmTraceDetail(traceId: string) {
  return useQuery({
    queryKey: ["apm-trace", traceId],
    queryFn: () => fetchApmTraceDetail(traceId),
    enabled: !!traceId
  });
}
