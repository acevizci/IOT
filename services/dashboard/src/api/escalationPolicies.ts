import { apiFetch } from "./client";

// Bildirim sistemi tasarımı: eskalasyon adımları önceden DOĞRUDAN tek bir
// şablon kuralına bağlıydı (yeniden kullanılamıyordu -- Zabbix Actions/
// PagerDuty Escalation Policy gibi DEĞİLDİ). Artık bağımsız, adlandırılmış bir
// politika: bir kez tanımlanır, istenildiği kadar kurala (şablon veya cihaza
// özel) atanabilir.
export interface EscalationPolicy {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  step_count: number;
}

export interface EscalationPolicyStep {
  id: string;
  step_order: number;
  delay_seconds: number;
  action_type: "notify" | "remote_command";
  media_type_id: string | null;
  media_type_name: string | null;
  remote_command: string | null;
}

export function fetchEscalationPolicies() {
  return apiFetch<EscalationPolicy[]>("/api/v1/escalation-policies");
}

export function createEscalationPolicy(input: { name: string; description?: string }) {
  return apiFetch<EscalationPolicy>("/api/v1/escalation-policies", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteEscalationPolicy(id: string) {
  return apiFetch<void>(`/api/v1/escalation-policies/${id}`, { method: "DELETE" });
}

export function fetchEscalationPolicySteps(policyId: string) {
  return apiFetch<EscalationPolicyStep[]>(`/api/v1/escalation-policies/${policyId}/steps`);
}

export function createEscalationPolicyStep(policyId: string, input: {
  step_order: number;
  delay_seconds: number;
  action_type: "notify" | "remote_command";
  media_type_id?: string;
  remote_command?: string;
}) {
  return apiFetch<EscalationPolicyStep>(`/api/v1/escalation-policies/${policyId}/steps`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteEscalationPolicyStep(id: string) {
  return apiFetch<void>(`/api/v1/escalation-policy-steps/${id}`, { method: "DELETE" });
}

// Bir kurala (şablon veya cihaza özel) eskalasyon politikası ata/kaldır --
// policy_id ZORUNLU alan (null = kaldır, uuid = ata).
export function setDeviceRuleEscalationPolicy(ruleId: string, policyId: string | null) {
  return apiFetch<{ id: string; escalation_policy_id: string | null }>(`/api/v1/alert-rules/${ruleId}/escalation-policy`, {
    method: "PATCH",
    body: JSON.stringify({ policy_id: policyId })
  });
}

export function setTemplateRuleEscalationPolicy(ruleId: string, policyId: string | null) {
  return apiFetch<{ id: string; escalation_policy_id: string | null }>(`/api/v1/alert-template-rules/${ruleId}/escalation-policy`, {
    method: "PATCH",
    body: JSON.stringify({ policy_id: policyId })
  });
}
