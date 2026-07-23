import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchAlertTemplates, fetchAlertTemplate, createAlertTemplate, deleteAlertTemplate, applyTemplate, fetchAlertTemplateTags,
  cloneTemplate, exportTemplate, importTemplate
} from "../../api/alertTemplates";

export function useAlertTemplates(params: { search?: string; tag?: string } = {}) {
  return useQuery({ queryKey: ["alert-templates", params], queryFn: () => fetchAlertTemplates(params) });
}

export function useCloneTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ templateId, name }: { templateId: string; name: string }) => cloneTemplate(templateId, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-templates"] })
  });
}

// Şablon kütüphanesi v2: taşınabilir JSON export/import -- yedekleme, paylaşım,
// farklı bir kuruluma aktarma. Export sonucu bir Blob olarak indiriliyor.
export function useExportTemplate() {
  return useMutation({
    mutationFn: async (templateId: string) => {
      const data = await exportTemplate(templateId);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(data.template?.name || "sablon").replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  });
}

export function useImportTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, data }: { name: string; data: Record<string, any> }) => importTemplate({ ...data, name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-templates"] })
  });
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
    onSuccess: () => {
      // device_count sütunu alert_rules join'inden hesaplandığı için templates listesi de
      // yenilenmeli, aksi halde uygulama başarılı olsa bile tablo eski sayıyı gösterir.
      qc.invalidateQueries({ queryKey: ["alert-rules"] });
      qc.invalidateQueries({ queryKey: ["alert-templates"] });
      qc.invalidateQueries({ queryKey: ["device-relations"] });
    }
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

import { updateTemplate, addTemplateRule, updateTemplateRule, deleteTemplateRule } from "../../api/alertTemplates";

export function useUpdateTemplate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof updateTemplate>[1]) => updateTemplate(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alert-template", id] });
      qc.invalidateQueries({ queryKey: ["alert-templates"] });
    }
  });
}

export function useAddTemplateRule(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof addTemplateRule>[1]) => addTemplateRule(templateId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-template", templateId] })
  });
}

export function useUpdateTemplateRule(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, input }: { ruleId: string; input: Parameters<typeof updateTemplateRule>[1] }) => updateTemplateRule(ruleId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-template", templateId] })
  });
}

export function useDeleteTemplateRule(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteTemplateRule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-template", templateId] })
  });
}

import { setTemplateRuleEscalationPolicy } from "../../api/escalationPolicies";

export function useSetTemplateRuleEscalationPolicy(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, policyId }: { ruleId: string; policyId: string | null }) => setTemplateRuleEscalationPolicy(ruleId, policyId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-template", templateId] })
  });
}
