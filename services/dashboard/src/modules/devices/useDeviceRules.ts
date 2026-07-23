import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchDeviceRules, createDeviceRule, deleteDeviceRule, toggleDeviceRule, fetchRuleDependencies, setRuleDependency, removeRuleDependency, setRuleAnomalyDetection, setRulePredictiveAnalytics } from "../../api/deviceRules";
import { setDeviceRuleEscalationPolicy } from "../../api/escalationPolicies";

export function useDeviceRules(deviceId: string) {
  return useQuery({
    queryKey: ["device-rules", deviceId],
    queryFn: () => fetchDeviceRules(deviceId),
    enabled: !!deviceId
  });
}

export function useRuleDependencies(ruleId: string) {
  return useQuery({
    queryKey: ["rule-dependencies", ruleId],
    queryFn: () => fetchRuleDependencies(ruleId),
    enabled: !!ruleId
  });
}

export function useSetRuleDependency(deviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, dependsOnRuleId }: { ruleId: string; dependsOnRuleId: string }) => setRuleDependency(ruleId, dependsOnRuleId),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["rule-dependencies", variables.ruleId] });
      qc.invalidateQueries({ queryKey: ["device-relations", deviceId] });
    }
  });
}

export function useRemoveRuleDependency(deviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, dependsOnRuleId }: { ruleId: string; dependsOnRuleId: string }) => removeRuleDependency(ruleId, dependsOnRuleId),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["rule-dependencies", variables.ruleId] });
      qc.invalidateQueries({ queryKey: ["device-relations", deviceId] });
    }
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

export function useSetRuleAnomalyDetection(deviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, enabled, sigma, seasonal }: { ruleId: string; enabled?: boolean; sigma?: number | null; seasonal?: boolean }) =>
      setRuleAnomalyDetection(ruleId, { enabled, sigma, seasonal }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["device-rules", deviceId] })
  });
}

export function useSetRulePredictiveAnalytics(deviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, enabled, horizonHours }: { ruleId: string; enabled?: boolean; horizonHours?: number }) =>
      setRulePredictiveAnalytics(ruleId, { enabled, horizon_hours: horizonHours }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["device-rules", deviceId] })
  });
}

export function useSetDeviceRuleEscalationPolicy(deviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, policyId }: { ruleId: string; policyId: string | null }) => setDeviceRuleEscalationPolicy(ruleId, policyId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["device-rules", deviceId] })
  });
}
