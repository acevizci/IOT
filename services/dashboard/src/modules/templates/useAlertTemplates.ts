import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchAlertTemplates, fetchAlertTemplate, createAlertTemplate, deleteAlertTemplate, applyTemplate } from "../../api/alertTemplates";

export function useAlertTemplates() {
  return useQuery({ queryKey: ["alert-templates"], queryFn: fetchAlertTemplates });
}

export function useAlertTemplate(id: string) {
  return useQuery({
    queryKey: ["alert-template", id],
    queryFn: () => fetchAlertTemplate(id),
    enabled: !!id
  });
}

export function useCreateAlertTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createAlertTemplate,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-templates"] })
  });
}

export function useDeleteAlertTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteAlertTemplate,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-templates"] })
  });
}

export function useApplyTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ templateId, deviceGroupId }: { templateId: string; deviceGroupId: string }) => applyTemplate(templateId, deviceGroupId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-rules"] })
  });
}
