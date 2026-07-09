import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchAlerts, fetchSuppressedAlerts, fetchAlertDetail,
  acknowledgeAlert, unacknowledgeAlert, addAlertComment
} from "../../api/alerts";
import type { AlertListFilters } from "../../api/alerts";

export function useAlerts(filters: AlertListFilters = {}) {
  return useQuery({
    queryKey: ["alerts", filters],
    queryFn: () => fetchAlerts(filters),
    refetchInterval: 20000
  });
}

export function useSuppressedAlerts() {
  return useQuery({
    queryKey: ["suppressed-alerts"],
    queryFn: fetchSuppressedAlerts,
    refetchInterval: 20000
  });
}

export function useAlertDetail(id: string) {
  return useQuery({
    queryKey: ["alert-detail", id],
    queryFn: () => fetchAlertDetail(id),
    enabled: !!id,
    refetchInterval: 15000
  });
}

export function useAcknowledgeAlert(alertId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => acknowledgeAlert(alertId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alert-detail", alertId] });
      qc.invalidateQueries({ queryKey: ["alerts"] });
    }
  });
}

export function useUnacknowledgeAlert(alertId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unacknowledgeAlert(alertId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alert-detail", alertId] });
      qc.invalidateQueries({ queryKey: ["alerts"] });
    }
  });
}

export function useAddAlertComment(alertId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (comment: string) => addAlertComment(alertId, comment),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-detail", alertId] })
  });
}
