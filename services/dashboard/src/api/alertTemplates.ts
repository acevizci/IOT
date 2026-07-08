import { apiFetch } from "./client";

export interface TemplateRuleInput {
  metric_name: string;
  condition: "gt" | "lt" | "eq";
  threshold: number;
  duration_seconds: number;
  severity: string;
}

export interface AlertTemplate {
  id: string;
  name: string;
  device_type: string | null;
  created_at: string;
  rule_count?: number;
}

export interface AlertTemplateDetail extends AlertTemplate {
  rules: Array<{ id: string; metric_name: string; condition: string; threshold: number; duration_seconds: number; severity: string }>;
}

export function fetchAlertTemplates() {
  return apiFetch<AlertTemplate[]>("/api/v1/alert-templates");
}

export function fetchAlertTemplate(id: string) {
  return apiFetch<AlertTemplateDetail>(`/api/v1/alert-templates/${id}`);
}

export function createAlertTemplate(input: { name: string; device_type?: string; rules: TemplateRuleInput[] }) {
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
