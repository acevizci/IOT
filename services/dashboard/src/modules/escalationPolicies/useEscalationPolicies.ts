import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchEscalationPolicies, createEscalationPolicy, deleteEscalationPolicy,
  fetchEscalationPolicySteps, createEscalationPolicyStep, deleteEscalationPolicyStep
} from "../../api/escalationPolicies";

export function useEscalationPolicies() {
  return useQuery({ queryKey: ["escalation-policies"], queryFn: fetchEscalationPolicies });
}

export function useCreateEscalationPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createEscalationPolicy,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["escalation-policies"] })
  });
}

export function useDeleteEscalationPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteEscalationPolicy,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["escalation-policies"] })
  });
}

export function useEscalationPolicySteps(policyId: string) {
  return useQuery({
    queryKey: ["escalation-policy-steps", policyId],
    queryFn: () => fetchEscalationPolicySteps(policyId),
    enabled: !!policyId
  });
}

export function useCreateEscalationPolicyStep(policyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof createEscalationPolicyStep>[1]) => createEscalationPolicyStep(policyId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["escalation-policy-steps", policyId] });
      qc.invalidateQueries({ queryKey: ["escalation-policies"] });
    }
  });
}

export function useDeleteEscalationPolicyStep(policyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteEscalationPolicyStep,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["escalation-policy-steps", policyId] });
      qc.invalidateQueries({ queryKey: ["escalation-policies"] });
    }
  });
}
