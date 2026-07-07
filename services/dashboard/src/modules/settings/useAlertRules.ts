import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchAlertRules, createAlertRule, updateAlertRule, deleteAlertRule } from "../../api/alertRules";

export function useAlertRules() {
  return useQuery({ queryKey: ["alert-rules"], queryFn: fetchAlertRules });
}

export function useCreateAlertRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createAlertRule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-rules"] })
  });
}

export function useToggleAlertRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => updateAlertRule(id, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-rules"] })
  });
}

export function useDeleteAlertRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteAlertRule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-rules"] })
  });
}
