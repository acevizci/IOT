import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchTemplateItems, createTemplateItem, deleteTemplateItem } from "../../api/alertTemplates";

export function useTemplateItems(templateId: string) {
  return useQuery({
    queryKey: ["template-items", templateId],
    queryFn: () => fetchTemplateItems(templateId),
    enabled: !!templateId
  });
}

export function useCreateTemplateItem(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof createTemplateItem>[1]) => createTemplateItem(templateId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["template-items", templateId] })
  });
}

export function useDeleteTemplateItem(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteTemplateItem,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["template-items", templateId] })
  });
}

import { updateTemplateItem } from "../../api/alertTemplates";

export function useUpdateTemplateItem(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, input }: { itemId: string; input: Parameters<typeof updateTemplateItem>[1] }) => updateTemplateItem(itemId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["template-items", templateId] })
  });
}
