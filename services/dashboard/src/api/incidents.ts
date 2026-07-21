import { apiFetch } from "./client";
import type { PaginatedResult } from "./devices";

// RCA Adım 6: incidents API katmanı -- core-service'teki GET /api/v1/incidents
// ve GET /api/v1/incidents/:id endpoint'lerine karşılık gelir.

export interface IncidentSummary {
  id: string;
  root_cause_device_id: string | null;
  root_cause_device_name: string | null;
  confidence: number;
  status: "open" | "resolved";
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  affected_count: number;
}

export interface IncidentAffectedAlert {
  id: string;
  alert_id: string;
  device_id: string;
  device_name: string;
  confidence: number;
  added_at: string;
  alert_message: string;
  alert_severity: string;
  alert_triggered_at: string;
  alert_resolved_at: string | null;
}

export interface IncidentDetail {
  id: string;
  tenant_id: string;
  root_cause_device_id: string | null;
  root_cause_device_name: string | null;
  root_cause_alert_id: string | null;
  root_cause_alert_message: string | null;
  root_cause_alert_triggered_at: string | null;
  root_cause_alert_resolved_at: string | null;
  confidence: number;
  status: "open" | "resolved";
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  affected_alerts: IncidentAffectedAlert[];
}

export interface IncidentListParams {
  status?: "open" | "resolved";
  root_cause_device_id?: string;
  page?: number;
  limit?: number;
}

export function fetchIncidents(params: IncidentListParams) {
  const search = new URLSearchParams();
  if (params.status) search.set("status", params.status);
  if (params.root_cause_device_id) search.set("root_cause_device_id", params.root_cause_device_id);
  if (params.page) search.set("page", String(params.page));
  if (params.limit) search.set("limit", String(params.limit));
  const qs = search.toString();
  return apiFetch<PaginatedResult<IncidentSummary>>(`/api/v1/incidents${qs ? `?${qs}` : ""}`);
}

export function fetchIncidentDetail(id: string) {
  return apiFetch<IncidentDetail>(`/api/v1/incidents/${id}`);
}
