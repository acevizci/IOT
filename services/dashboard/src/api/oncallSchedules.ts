import { apiFetch } from "./client";

// Nöbet çizelgesi (bildirim sistemi son parçası, kullanıcıyla konuşulup kararlaştırıldı):
// takvim bazlı, saat/gün bazlı katmanlar (haftalık tekrar eden pencereler, öncelik bazlı
// çakışma çözümü) + manuel geçersiz kılmalar. Bir eskalasyon adımı bir çizelgeye
// hedeflenebiliyor (bkz. escalationPolicies.ts) -- bu dosya çizelgenin kendisini yönetir.
export interface OnCallSchedule {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  layer_count: number;
}

export interface OnCallLayer {
  id: string;
  user_id: string;
  user_email: string;
  day_of_week: number | null; // null = her gün, 0=Pazar...6=Cumartesi (Postgres EXTRACT(DOW))
  start_time: string;
  end_time: string;
  priority: number;
}

export interface OnCallOverride {
  id: string;
  user_id: string;
  user_email: string;
  starts_at: string;
  ends_at: string;
}

export interface CurrentOnCall {
  user_id: string | null;
  email: string | null;
}

export function fetchOnCallSchedules() {
  return apiFetch<OnCallSchedule[]>("/api/v1/oncall-schedules");
}

export function createOnCallSchedule(input: { name: string; description?: string }) {
  return apiFetch<OnCallSchedule>("/api/v1/oncall-schedules", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteOnCallSchedule(id: string) {
  return apiFetch<void>(`/api/v1/oncall-schedules/${id}`, { method: "DELETE" });
}

export function fetchCurrentOnCall(scheduleId: string) {
  return apiFetch<CurrentOnCall>(`/api/v1/oncall-schedules/${scheduleId}/current`);
}

export function fetchOnCallLayers(scheduleId: string) {
  return apiFetch<OnCallLayer[]>(`/api/v1/oncall-schedules/${scheduleId}/layers`);
}

export function createOnCallLayer(scheduleId: string, input: {
  user_id: string;
  day_of_week?: number | null;
  start_time: string;
  end_time: string;
  priority: number;
}) {
  return apiFetch<OnCallLayer>(`/api/v1/oncall-schedules/${scheduleId}/layers`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteOnCallLayer(id: string) {
  return apiFetch<void>(`/api/v1/oncall-layers/${id}`, { method: "DELETE" });
}

export function fetchOnCallOverrides(scheduleId: string) {
  return apiFetch<OnCallOverride[]>(`/api/v1/oncall-schedules/${scheduleId}/overrides`);
}

export function createOnCallOverride(scheduleId: string, input: { user_id: string; starts_at: string; ends_at: string }) {
  return apiFetch<OnCallOverride>(`/api/v1/oncall-schedules/${scheduleId}/overrides`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteOnCallOverride(id: string) {
  return apiFetch<void>(`/api/v1/oncall-overrides/${id}`, { method: "DELETE" });
}
