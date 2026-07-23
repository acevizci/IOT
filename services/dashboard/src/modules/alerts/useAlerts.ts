import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchAlerts, fetchSuppressedAlerts, fetchAlertDetail,
  acknowledgeAlert, unacknowledgeAlert, addAlertComment, updateAlertSeverity, fetchSeveritySummary, bulkAcknowledgeAlerts,
  resolveAlert, muteAlert, unmuteAlert
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

export function useUpdateAlertSeverity(alertId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (severity: string) => updateAlertSeverity(alertId, severity),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alert-detail", alertId] });
      qc.invalidateQueries({ queryKey: ["alerts"] });
    }
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

export function useMuteAlert(alertId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (minutes: number) => muteAlert(alertId, minutes),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alert-detail", alertId] });
      qc.invalidateQueries({ queryKey: ["alerts"] });
    }
  });
}

export function useUnmuteAlert(alertId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unmuteAlert(alertId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alert-detail", alertId] });
      qc.invalidateQueries({ queryKey: ["alerts"] });
    }
  });
}

export function useResolveAlert(alertId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => resolveAlert(alertId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alert-detail", alertId] });
      qc.invalidateQueries({ queryKey: ["alerts"] });
      qc.invalidateQueries({ queryKey: ["alerts-severity-summary"] });
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


export function useSeveritySummary(deviceId?: string, deviceGroupId?: string) {
  return useQuery({
    queryKey: ["alerts-severity-summary", deviceId, deviceGroupId],
    queryFn: () => fetchSeveritySummary(deviceId, deviceGroupId),
    refetchInterval: 20000
  });
}

export function useBulkAcknowledgeAlerts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => bulkAcknowledgeAlerts(ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alerts"] });
      qc.invalidateQueries({ queryKey: ["alerts-severity-summary"] });
    }
  });
}
