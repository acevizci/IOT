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

export function fetchTopTalkers(hours = 1, limit = 20) {
  return apiFetch<TopTalker[]>(`/api/v1/traffic/top-talkers?hours=${hours}&limit=${limit}`);
}

export function fetchTrafficSummary(hours = 1) {
  return apiFetch<TrafficSummary>(`/api/v1/traffic/summary?hours=${hours}`);
}

export function fetchProtocolBreakdown(hours = 1) {
  return apiFetch<ProtocolBreakdown[]>(`/api/v1/traffic/protocol-breakdown?hours=${hours}`);
}
