import { apiFetch } from "./client";

export interface QueueOverviewRow {
  collector_type: string;
  not_due: number;
  bucket_5s: number;
  bucket_10s: number;
  bucket_30s: number;
  bucket_1m: number;
  bucket_5m: number;
  bucket_over_5m: number;
  total: number;
}

export interface QueueDetailRow {
  device_id: string;
  device_name: string;
  resource_type: string;
  resource_id: string;
  collector_type: string;
  resource_name: string;
  next_due_at: string;
  last_collected_at: string | null;
  last_duration_ms: number | null;
  last_error: string | null;
  delay_seconds: number;
}

export function fetchQueueOverview() {
  return apiFetch<QueueOverviewRow[]>("/api/v1/queue/overview");
}

export function fetchQueueDetails(collectorType?: string, deviceId?: string) {
  const query = new URLSearchParams();
  if (collectorType) query.set("collector_type", collectorType);
  if (deviceId) query.set("device_id", deviceId);
  return apiFetch<QueueDetailRow[]>(`/api/v1/queue/details?${query.toString()}`);
}
