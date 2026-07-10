import { apiFetch } from "./client";

export interface WebScenario {
  id: string;
  name: string;
  user_agent: string | null;
  polling_interval_seconds: number;
  step_count: number;
}

export interface WebScenarioStep {
  id: string;
  step_order: number;
  name: string;
  url: string;
  expected_status_code: number;
}

export interface WebScenarioDetail extends WebScenario {
  template_id: string;
  steps: WebScenarioStep[];
}

export function fetchTemplateWebScenarios(templateId: string) {
  return apiFetch<WebScenario[]>(`/api/v1/alert-templates/${templateId}/web-scenarios`);
}

export function fetchWebScenario(id: string) {
  return apiFetch<WebScenarioDetail>(`/api/v1/web-scenarios/${id}`);
}

export function createWebScenario(templateId: string, input: {
  name: string;
  user_agent?: string;
  polling_interval_seconds: number;
  steps: Array<{ name: string; url: string; expected_status_code: number }>;
}) {
  return apiFetch<{ id: string; name: string }>(`/api/v1/alert-templates/${templateId}/web-scenarios`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteWebScenario(id: string) {
  return apiFetch<void>(`/api/v1/web-scenarios/${id}`, { method: "DELETE" });
}
