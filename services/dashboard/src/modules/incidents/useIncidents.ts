import { useQuery } from "@tanstack/react-query";
import { fetchIncidents, fetchIncidentDetail, type IncidentListParams } from "../../api/incidents";

export function useIncidents(params: IncidentListParams) {
  return useQuery({
    queryKey: ["incidents", params],
    queryFn: () => fetchIncidents(params)
  });
}

export function useIncidentDetail(id: string) {
  return useQuery({
    queryKey: ["incident", id],
    queryFn: () => fetchIncidentDetail(id),
    enabled: !!id
  });
}
