import { apiFetch } from "./client";

export interface TemplateRuleInput {
  metric_name: string;
  condition: "gt" | "lt" | "eq";
  threshold: number;
  duration_seconds: number;
  severity: string;
  depends_on_index?: number | null;
}

export interface AlertTemplate {
  id: string;
  name: string;
  device_type: string | null;
  created_at: string;
  rule_count?: number;
  device_count?: number;
  item_count?: number;
  tags?: string[];
  parent_template_id?: string | null;
  parent_template_name?: string | null;
}

export interface AlertTemplateDetail extends AlertTemplate {
  rules: Array<{
    id: string; metric_name: string; condition: string; threshold: number; duration_seconds: number; severity: string;
    depends_on_template_rule_id: string | null; depends_on_metric_name: string | null;
  }>;
  children: Array<{ id: string; name: string }>;
}

export interface TemplateItem {
  id: string;
  metric_name: string;
  oid: string;
  data_type: string;
  unit: string | null;
  polling_interval_seconds: number;
  is_table: boolean;
}

export function fetchAlertTemplates(params: { search?: string; tag?: string } = {}) {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  if (params.tag) query.set("tag", params.tag);
  const qs = query.toString();
  return apiFetch<AlertTemplate[]>(`/api/v1/alert-templates${qs ? `?${qs}` : ""}`);
}

export function fetchAlertTemplate(id: string) {
  return apiFetch<AlertTemplateDetail>(`/api/v1/alert-templates/${id}`);
}

export function createAlertTemplate(input: { name: string; device_type?: string; tags?: string[]; parent_template_id?: string | null; rules: TemplateRuleInput[] }) {
  return apiFetch<AlertTemplateDetail>("/api/v1/alert-templates", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteAlertTemplate(id: string) {
  return apiFetch<void>(`/api/v1/alert-templates/${id}`, { method: "DELETE" });
}

export function applyTemplate(templateId: string, deviceGroupId: string) {
  return apiFetch<{ appliedToDevices: number; rulesCreated: number }>(`/api/v1/alert-templates/${templateId}/apply`, {
    method: "POST",
    body: JSON.stringify({ device_group_id: deviceGroupId })
  });
}

export function fetchTemplateItems(templateId: string) {
  return apiFetch<TemplateItem[]>(`/api/v1/alert-templates/${templateId}/items`);
}

export function createTemplateItem(templateId: string, input: {
  metric_name: string;
  oid: string;
  data_type: "gauge" | "counter" | "string";
  unit?: string;
  polling_interval_seconds: number;
  is_table: boolean;
}) {
  return apiFetch<TemplateItem>(`/api/v1/alert-templates/${templateId}/items`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteTemplateItem(id: string) {
  return apiFetch<void>(`/api/v1/template-items/${id}`, { method: "DELETE" });
}

export interface TemplateDevice {
  id: string;
  name: string;
  ip_address: string;
  device_type: string;
  status: string;
}

export function fetchTemplateDevices(templateId: string) {
  return apiFetch<TemplateDevice[]>(`/api/v1/alert-templates/${templateId}/devices`);
}

export function fetchAlertTemplateTags() {
  return apiFetch<string[]>("/api/v1/alert-templates/tags");
}
