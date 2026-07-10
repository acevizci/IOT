import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchTemplateWebScenarios, fetchWebScenario, createWebScenario, deleteWebScenario } from "../../api/webScenarios";

export function useTemplateWebScenarios(templateId: string) {
  return useQuery({
    queryKey: ["web-scenarios", templateId],
    queryFn: () => fetchTemplateWebScenarios(templateId),
    enabled: !!templateId
  });
}

export function useWebScenario(id: string) {
  return useQuery({
    queryKey: ["web-scenario", id],
    queryFn: () => fetchWebScenario(id),
    enabled: !!id
  });
}

export function useCreateWebScenario(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof createWebScenario>[1]) => createWebScenario(templateId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["web-scenarios", templateId] })
  });
}

export function useDeleteWebScenario(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteWebScenario,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["web-scenarios", templateId] })
  });
}
