import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchDashboards, createDashboard, deleteDashboard,
  fetchDashboardWidgets, createWidget, updateWidget, deleteWidget, bulkUpdateWidgets, fetchKpiValue
} from "../../api/dashboards";
import type { BulkWidgetInput } from "../../api/dashboards";

export function useDashboards() {
  return useQuery({ queryKey: ["dashboards"], queryFn: fetchDashboards });
}

export function useCreateDashboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createDashboard,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboards"] })
  });
}

export function useDeleteDashboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteDashboard,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboards"] })
  });
}

export function useDashboardWidgets(dashboardId: string) {
  return useQuery({
    queryKey: ["dashboard-widgets", dashboardId],
    queryFn: () => fetchDashboardWidgets(dashboardId),
    enabled: !!dashboardId
  });
}

export function useCreateWidget(dashboardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof createWidget>[1]) => createWidget(dashboardId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard-widgets", dashboardId] })
  });
}

export function useUpdateWidget(dashboardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof updateWidget>[1] }) => updateWidget(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard-widgets", dashboardId] })
  });
}

export function useDeleteWidget(dashboardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteWidget,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard-widgets", dashboardId] })
  });
}

// Düzenleme modu "Kaydet" butonu bunu çağırır — bkz. Faz 9.6 + 9.10a.
export function useBulkUpdateWidgets(dashboardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (widgets: BulkWidgetInput[]) => bulkUpdateWidgets(dashboardId, widgets),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard-widgets", dashboardId] })
  });
}

export function useKpiValue(source: string) {
  return useQuery({
    queryKey: ["dashboard-kpi", source],
    queryFn: () => fetchKpiValue(source),
    refetchInterval: 30000
  });
}
