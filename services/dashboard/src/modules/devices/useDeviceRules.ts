import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchDeviceRules, createDeviceRule, deleteDeviceRule, toggleDeviceRule } from "../../api/deviceRules";

export function useDeviceRules(deviceId: string) {
  return useQuery({
    queryKey: ["device-rules", deviceId],
    queryFn: () => fetchDeviceRules(deviceId),
    enabled: !!deviceId
  });
}

export function useCreateDeviceRule(deviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof createDeviceRule>[1]) => createDeviceRule(deviceId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["device-rules", deviceId] });
      qc.invalidateQueries({ queryKey: ["device-relations", deviceId] });
    }
  });
}

export function useDeleteDeviceRule(deviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteDeviceRule,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["device-rules", deviceId] });
      qc.invalidateQueries({ queryKey: ["device-relations", deviceId] });
    }
  });
}

export function useToggleDeviceRule(deviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, active }: { ruleId: string; active: boolean }) => toggleDeviceRule(ruleId, active),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["device-rules", deviceId] })
  });
}
