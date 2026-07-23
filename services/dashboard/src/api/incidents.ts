import { apiFetch } from "./client";
import type { PaginatedResult } from "./devices";

// RCA Adım 6: incidents API katmanı -- core-service'teki GET /api/v1/incidents
// ve GET /api/v1/incidents/:id endpoint'lerine karşılık gelir.

// RCA incelemesi -- confidence motorunun döküm bileşenleri (relationship_weight
// × temporal_score × hierarchy_weight × hop_decay = confidence). Eski
// incident'larda (migration 098 öncesi) bu alanlar null olabilir -- frontend
// bu durumda döküm panelini gizler, sadece çıplak sayıyı gösterir.
export interface ConfidenceBreakdown {
  relationship_weight: number | null;
  temporal_score: number | null;
  hierarchy_weight: number | null;
  hop_decay: number | null;
  hop_distance: number | null;
}

export interface IncidentSummary extends ConfidenceBreakdown {
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

export interface IncidentAffectedAlert extends ConfidenceBreakdown {
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

export interface IncidentDetail extends ConfidenceBreakdown {
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
  path_device_ids: string[] | null;
  path_device_names: string[] | null;
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
