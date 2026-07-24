import { apiFetch } from "./client";

// Monitoring Proxy: Zabbix-tarzı izleme proxy'si -- uzak/segmentli bir sitedeki
// agent'lar merkez yerine bir proxy'ye bağlanır, proxy kendi yerel Postgres'inde
// buffer'layıp merkeze batch olarak iletir (bkz. services/proxy, services/core
// /api/v1/proxy/* uçları).
export interface Proxy {
  id: string;
  name: string;
  address: string | null;
  status: "pending" | "active" | "down";
  heartbeat_seconds: number;
  metrics_flush_seconds: number;
  queue_retention_limit: number;
  last_heartbeat_at: string | null;
  connected_device_count: number;
  pending_queue_size: number;
  last_successful_sync_at: string | null;
  proxy_version: string | null;
  disk_usage_bytes: number | null;
  created_at: string;
}

export function fetchProxies() {
  return apiFetch<Proxy[]>("/api/v1/proxies");
}

export function updateProxy(
  id: string,
  input: Partial<{ address: string; heartbeat_seconds: number; metrics_flush_seconds: number; queue_retention_limit: number }>
) {
  return apiFetch<Proxy>(`/api/v1/proxies/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteProxy(id: string) {
  return apiFetch<void>(`/api/v1/proxies/${id}`, { method: "DELETE" });
}

export function testProxyConnection(id: string) {
  return apiFetch<{ ok: boolean; error?: string }>(`/api/v1/proxies/${id}/test-connection`, { method: "POST" });
}

export interface ProxyRegistrationToken {
  id: string;
  name: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  used_at: string | null;
}

export function fetchProxyRegistrationTokens() {
  return apiFetch<ProxyRegistrationToken[]>("/api/v1/proxy-registration-tokens");
}

export function createProxyRegistrationToken(name: string) {
  return apiFetch<ProxyRegistrationToken & { token: string }>("/api/v1/proxy-registration-tokens", {
    method: "POST",
    body: JSON.stringify({ name })
  });
}

export function deleteProxyRegistrationToken(id: string) {
  return apiFetch<void>(`/api/v1/proxy-registration-tokens/${id}`, { method: "DELETE" });
}
