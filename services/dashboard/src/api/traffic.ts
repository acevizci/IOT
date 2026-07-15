import { apiFetch } from "./client";

export interface TopTalker {
  src_ip: string;
  dst_ip: string;
  total_bytes: number;
  total_packets: number;
  flow_count: number;
}
export interface TrafficSummary {
  total_bytes: number;
  total_packets: number;
  flow_count: number;
  unique_sources: number;
  unique_destinations: number;
}
export interface ProtocolBreakdown {
  dst_port: number;
  protocol: number;
  total_bytes: number;
  flow_count: number;
}

export function fetchTopTalkers(hours = 1, limit = 20, deviceId?: string) {
  const deviceParam = deviceId ? `&device_id=${deviceId}` : "";
  return apiFetch<TopTalker[]>(`/api/v1/traffic/top-talkers?hours=${hours}&limit=${limit}${deviceParam}`);
}
export function fetchTrafficSummary(hours = 1, deviceId?: string) {
  const deviceParam = deviceId ? `&device_id=${deviceId}` : "";
  return apiFetch<TrafficSummary>(`/api/v1/traffic/summary?hours=${hours}${deviceParam}`);
}
export function fetchProtocolBreakdown(hours = 1, deviceId?: string) {
  const deviceParam = deviceId ? `&device_id=${deviceId}` : "";
  return apiFetch<ProtocolBreakdown[]>(`/api/v1/traffic/protocol-breakdown?hours=${hours}${deviceParam}`);
}
