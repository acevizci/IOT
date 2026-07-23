import { apiFetch } from "./client";

// APM Adım 7: core-service'teki GET /api/v1/apm/* endpoint'lerine karşılık gelir.

export interface ApmServiceSummary {
  service_name: string;
  request_count: number;
  requests_per_min: number;
  error_rate_pct: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  // apm-sync/service her servisi devices'a (device_type='service') yazıyor --
  // servis henüz senkronize olmadıysa (ilk trace ile senkronizasyon arasındaki
  // kısa an) null olabilir.
  device_id: string | null;
}

export interface ApmTrendPoint {
  bucket: string;
  request_count: number;
  error_rate_pct: number;
  p95_ms: number;
}

export interface ApmTraceSummary {
  trace_id: string;
  service_name: string;
  operation_name: string;
  timestamp: string;
  duration_ms: number;
  status_code: number;
  span_count: number;
}

export interface ApmSpan {
  span_id: string;
  parent_span_id: string;
  service_name: string;
  operation_name: string;
  timestamp: string;
  duration_ms: number;
  status_code: number;
  kind: number;
  attributes: Record<string, string>;
}

export interface ApmTraceDetail {
  trace_id: string;
  spans: ApmSpan[];
}

export interface ApmServicesParams {
  hours?: number;
}

export interface ApmTracesParams {
  service_name?: string;
  min_duration_ms?: number;
  hours?: number;
  limit?: number;
  errors_only?: boolean;
}

export function fetchApmServices(params: ApmServicesParams) {
  const search = new URLSearchParams();
  if (params.hours) search.set("hours", String(params.hours));
  const qs = search.toString();
  return apiFetch<ApmServiceSummary[]>(`/api/v1/apm/services${qs ? `?${qs}` : ""}`);
}

export function fetchApmTraces(params: ApmTracesParams) {
  const search = new URLSearchParams();
  if (params.service_name) search.set("service_name", params.service_name);
  if (params.min_duration_ms) search.set("min_duration_ms", String(params.min_duration_ms));
  if (params.hours) search.set("hours", String(params.hours));
  if (params.limit) search.set("limit", String(params.limit));
  if (params.errors_only) search.set("errors_only", "true");
  const qs = search.toString();
  return apiFetch<ApmTraceSummary[]>(`/api/v1/apm/traces${qs ? `?${qs}` : ""}`);
}

export function fetchApmTraceDetail(traceId: string) {
  return apiFetch<ApmTraceDetail>(`/api/v1/apm/traces/${traceId}`);
}

export function fetchApmServiceTrend(serviceName: string, hours: number) {
  return apiFetch<ApmTrendPoint[]>(`/api/v1/apm/services/${encodeURIComponent(serviceName)}/trend?hours=${hours}`);
}
