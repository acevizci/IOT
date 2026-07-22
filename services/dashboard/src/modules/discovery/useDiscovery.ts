import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchDiscoveryRules, createDiscoveryRule, updateDiscoveryRule, deleteDiscoveryRule, runDiscoveryRule,
  fetchDiscoveryCandidates, dismissDiscoveryCandidate, bulkAddDiscoveryCandidates
} from "../../api/discoveryRules";
import type { DiscoveryRuleInput } from "../../api/discoveryRules";

export function useDiscoveryRules() {
  return useQuery({ queryKey: ["discovery-rules"], queryFn: fetchDiscoveryRules });
}

export function useCreateDiscoveryRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createDiscoveryRule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["discovery-rules"] })
  });
}

export function useUpdateDiscoveryRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<DiscoveryRuleInput> }) => updateDiscoveryRule(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["discovery-rules"] })
  });
}

export function useDeleteDiscoveryRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteDiscoveryRule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["discovery-rules"] })
  });
}

export function useRunDiscoveryRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: runDiscoveryRule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["discovery-rules"] })
  });
}

export function useDiscoveryCandidates() {
  return useQuery({ queryKey: ["discovery-candidates"], queryFn: fetchDiscoveryCandidates, refetchInterval: 15000 });
}

export function useDismissDiscoveryCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: dismissDiscoveryCandidate,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["discovery-candidates"] })
  });
}

export function useBulkAddDiscoveryCandidates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, deviceType }: { ids: string[]; deviceType: string }) => bulkAddDiscoveryCandidates(ids, deviceType),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["discovery-candidates"] });
      qc.invalidateQueries({ queryKey: ["devices"] });
    }
  });
}
