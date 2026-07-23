import { apiFetch } from "./client";
import type { PaginatedResult } from "./devices";

export interface AlertTag {
  tag: string;
  value: string;
}
export interface Alert {
  id: string;
  device_id: string;
  device_name: string | null;
  metric_name: string;
  triggered_at: string;
  resolved_at: string | null;
  severity: string;
  message: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  tags: AlertTag[];
  // Anomali Tespiti: rolling z-score tabanlı istatistiksel alarm (eşik-bazlı
  // alarmlardan AYRI, aynı anda ikisi de açık olabilir).
  is_anomaly: boolean;
  // Predictive Analytics: doğrusal regresyon tabanlı trend tahmini (Anomali
  // Tespiti'yle AYNI gölge-kural mimarisi, is_anomaly'nin ufuk/trend eşdeğeri).
  is_predictive: boolean;
}

export interface AlertListFilters {
  status?: "open" | "resolved";
  severity?: string;
  device_id?: string;
  device_group_id?: string;
  anomaly_only?: boolean;
  predictive_only?: boolean;
  from?: string;
  to?: string;
  search?: string;
  tags?: string;
  unacknowledged_only?: boolean;
  sort?: string;
  order?: string;
  page?: number;
  limit?: number;
}

export function fetchAlerts(filters: AlertListFilters = {}) {
  const query = new URLSearchParams();
  if (filters.status) query.set("status", filters.status);
  if (filters.severity) query.set("severity", filters.severity);
  if (filters.device_id) query.set("device_id", filters.device_id);
  if (filters.device_group_id) query.set("device_group_id", filters.device_group_id);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (filters.search) query.set("search", filters.search);
  if (filters.tags) query.set("tags", filters.tags);
  if (filters.unacknowledged_only) query.set("unacknowledged_only", "true");
  if (filters.anomaly_only) query.set("anomaly_only", "true");
  if (filters.predictive_only) query.set("predictive_only", "true");
  if (filters.sort) query.set("sort", filters.sort);
  if (filters.order) query.set("order", filters.order);
  query.set("page", String(filters.page ?? 1));
  query.set("limit", String(filters.limit ?? 50));
  return apiFetch<PaginatedResult<Alert>>(`/api/v1/alerts?${query.toString()}`);
}


export interface SeveritySummaryItem {
  severity: string;
  count: number;
}
export function fetchSeveritySummary(deviceId?: string, deviceGroupId?: string) {
  const query = new URLSearchParams();
  if (deviceId) query.set("device_id", deviceId);
  if (deviceGroupId) query.set("device_group_id", deviceGroupId);
  return apiFetch<SeveritySummaryItem[]>(`/api/v1/alerts/severity-summary?${query.toString()}`);
}

export interface AlertComment {
  id: string;
  comment: string;
  created_at: string;
  user_email: string;
}

export interface NotificationDelivery {
  id: string;
  channel_type: string;
  destination: string;
  status: "sent" | "failed";
  error_message: string | null;
  sent_at: string;
  media_type_name: string | null;
}

export interface SuppressedByThis {
  id: string;
  message: string;
  suppressed_at: string;
  metric_name: string;
}

export interface TimelineEvent {
  type: "triggered" | "notification" | "escalation_notification" | "comment" | "acknowledged" | "resolved";
  timestamp: string;
  value?: number | null;
  threshold?: number | null;
  condition?: string | null;
  channel_type?: "email" | "webhook";
  destination?: string;
  status?: "sent" | "failed";
  error_message?: string | null;
  step_order?: number;
  user_email?: string;
  comment?: string;
}

export interface AlertDetail {
  id: string;
  device_id: string | null;
  device_name: string | null;
  ip_address: string | null;
  device_type: string | null;
  rule_id: string | null;
  metric_name: string | null;
  condition: string | null;
  threshold: number | null;
  value: number | null;
  triggered_at: string;
  resolved_at: string | null;
  severity: string;
  message: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  acknowledged_by_email: string | null;
  resolved_manually_by: string | null;
  resolved_manually_by_email: string | null;
  duration_seconds: number | null;
  rule_active: boolean | null;
  from_template: boolean | null;
  is_anomaly: boolean;
  is_predictive: boolean;
  // Anomali alarmı AÇILDIĞI ANDAKİ mean±sigma bandı (baseline canlı yeniden
  // hesaplandığı için donduruldu) -- grafikte anomali bandını çizmek için.
  baseline_lower: number | null;
  baseline_upper: number | null;
  // Eskalasyon durumu -- bkz. escalationPolicies.ts. last_escalation_step=0
  // henüz hiçbir adımın tetiklenmediği, escalation_policy_id=null ise bu
  // kurala hiç politika atanmadığı anlamına gelir.
  last_escalation_step: number;
  escalation_policy_id: string | null;
  escalation_policy_name: string | null;
  escalation_step_count: number;
  comments: AlertComment[];
  notification_deliveries: NotificationDelivery[];
  suppressed_by_this: SuppressedByThis[];
  timeline: TimelineEvent[];
}

export function fetchAlertDetail(id: string) {
  return apiFetch<AlertDetail>(`/api/v1/alerts/${id}`);
}

export function acknowledgeAlert(id: string) {
  return apiFetch<{ id: string; acknowledged_at: string; acknowledged_by: string }>(`/api/v1/alerts/${id}/acknowledge`, {
    method: "POST"
  });
}

export function unacknowledgeAlert(id: string) {
  return apiFetch<void>(`/api/v1/alerts/${id}/acknowledge`, { method: "DELETE" });
}

export function resolveAlert(id: string) {
  return apiFetch<{ id: string; resolved_at: string }>(`/api/v1/alerts/${id}/resolve`, { method: "POST" });
}

export function bulkAcknowledgeAlerts(ids: string[]) {
  return apiFetch<{ acknowledged: number }>(`/api/v1/alerts/bulk-acknowledge`, {
    method: "POST",
    body: JSON.stringify({ ids })
  });
}

// Bir alarmın severity'sini sonradan elle değiştirebilme (triage).
export function updateAlertSeverity(id: string, severity: string) {
  return apiFetch<{ id: string; severity: string }>(`/api/v1/alerts/${id}/severity`, {
    method: "PATCH",
    body: JSON.stringify({ severity })
  });
}

export function addAlertComment(id: string, comment: string) {
  return apiFetch<AlertComment>(`/api/v1/alerts/${id}/comments`, {
    method: "POST",
    body: JSON.stringify({ comment })
  });
}

export interface SuppressedAlert {
  id: string;
  message: string;
  suppressed_at: string;
  device_name: string;
  device_id: string;
  suppressed_metric: string;
  suppressing_metric: string;
}

export function fetchSuppressedAlerts() {
  return apiFetch<SuppressedAlert[]>("/api/v1/suppressed-alerts");
}
