import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchOnCallSchedules, createOnCallSchedule, deleteOnCallSchedule, fetchCurrentOnCall,
  fetchOnCallLayers, createOnCallLayer, deleteOnCallLayer,
  fetchOnCallOverrides, createOnCallOverride, deleteOnCallOverride
} from "../../api/oncallSchedules";

export function useOnCallSchedules() {
  return useQuery({ queryKey: ["oncall-schedules"], queryFn: fetchOnCallSchedules });
}

export function useCreateOnCallSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createOnCallSchedule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["oncall-schedules"] })
  });
}

export function useDeleteOnCallSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteOnCallSchedule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["oncall-schedules"] })
  });
}

// 60sn'de bir yenileniyor -- "şu an nöbetçi kim" zamana bağlı, sekme açık kalırsa
// vardiya değişince otomatik güncellensin diye.
export function useCurrentOnCall(scheduleId: string) {
  return useQuery({
    queryKey: ["oncall-current", scheduleId],
    queryFn: () => fetchCurrentOnCall(scheduleId),
    enabled: !!scheduleId,
    refetchInterval: 60000
  });
}

export function useOnCallLayers(scheduleId: string) {
  return useQuery({
    queryKey: ["oncall-layers", scheduleId],
    queryFn: () => fetchOnCallLayers(scheduleId),
    enabled: !!scheduleId
  });
}

export function useCreateOnCallLayer(scheduleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof createOnCallLayer>[1]) => createOnCallLayer(scheduleId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["oncall-layers", scheduleId] });
      qc.invalidateQueries({ queryKey: ["oncall-current", scheduleId] });
      qc.invalidateQueries({ queryKey: ["oncall-schedules"] });
    }
  });
}

export function useDeleteOnCallLayer(scheduleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteOnCallLayer,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["oncall-layers", scheduleId] });
      qc.invalidateQueries({ queryKey: ["oncall-current", scheduleId] });
      qc.invalidateQueries({ queryKey: ["oncall-schedules"] });
    }
  });
}

export function useOnCallOverrides(scheduleId: string) {
  return useQuery({
    queryKey: ["oncall-overrides", scheduleId],
    queryFn: () => fetchOnCallOverrides(scheduleId),
    enabled: !!scheduleId
  });
}

export function useCreateOnCallOverride(scheduleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof createOnCallOverride>[1]) => createOnCallOverride(scheduleId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["oncall-overrides", scheduleId] });
      qc.invalidateQueries({ queryKey: ["oncall-current", scheduleId] });
    }
  });
}

export function useDeleteOnCallOverride(scheduleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteOnCallOverride,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["oncall-overrides", scheduleId] });
      qc.invalidateQueries({ queryKey: ["oncall-current", scheduleId] });
    }
  });
}
