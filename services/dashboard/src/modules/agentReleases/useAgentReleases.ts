import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchAgentReleases, publishAgentRelease } from "../../api/agentReleases";

export function useAgentReleases() {
  return useQuery({ queryKey: ["agent-releases"], queryFn: fetchAgentReleases });
}

export function usePublishAgentRelease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: publishAgentRelease,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent-releases"] })
  });
}
