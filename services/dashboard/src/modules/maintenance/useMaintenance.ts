import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchMaintenanceWindows, fetchMaintenanceWindow, createMaintenanceWindow, deleteMaintenanceWindow } from "../../api/maintenance";

export function useMaintenanceWindows() {
  return useQuery({ queryKey: ["maintenance-windows"], queryFn: fetchMaintenanceWindows, refetchInterval: 30000 });
}

export function useMaintenanceWindow(id: string) {
  return useQuery({
    queryKey: ["maintenance-window", id],
    queryFn: () => fetchMaintenanceWindow(id),
    enabled: !!id
  });
}

export function useCreateMaintenanceWindow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createMaintenanceWindow,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["maintenance-windows"] })
  });
}

export function useDeleteMaintenanceWindow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteMaintenanceWindow,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["maintenance-windows"] })
  });
}

import { fetchGroupMaintenanceWindows } from "../../api/maintenance";

export function useGroupMaintenanceWindows(groupId: string) {
  return useQuery({
    queryKey: ["group-maintenance-windows", groupId],
    queryFn: () => fetchGroupMaintenanceWindows(groupId),
    enabled: !!groupId
  });
}
