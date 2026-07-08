import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchAlertTemplates, fetchAlertTemplate, createAlertTemplate, deleteAlertTemplate, applyTemplate, fetchAlertTemplateTags } from "../../api/alertTemplates";

export function useAlertTemplates(params: { search?: string; tag?: string } = {}) {
  return useQuery({ queryKey: ["alert-templates", params], queryFn: () => fetchAlertTemplates(params) });
}

export function useAlertTemplateTags() {
  return useQuery({ queryKey: ["alert-template-tags"], queryFn: fetchAlertTemplateTags });
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

import { fetchTemplateDevices } from "../../api/alertTemplates";

export function useTemplateDevices(templateId: string) {
  return useQuery({
    queryKey: ["template-devices", templateId],
    queryFn: () => fetchTemplateDevices(templateId),
    enabled: !!templateId
  });
}
