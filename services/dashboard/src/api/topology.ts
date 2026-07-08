import { apiFetch } from "./client";

export interface TopologyNode {
  id: string;
  name: string;
  ip_address: string;
  device_type: string;
  status: string;
}

export interface ManualLink {
  id: string;
  device_a_id: string;
  device_b_id: string;
  interface_a: string | null;
  interface_b: string | null;
}

export interface TrafficEdge {
  device_a_id: string;
  device_b_id: string;
  total_bytes: number;
}

export interface TopologyData {
  nodes: TopologyNode[];
  manualLinks: ManualLink[];
  trafficEdges: TrafficEdge[];
}

export function fetchTopology(hours = 24) {
  return apiFetch<TopologyData>(`/api/v1/topology?hours=${hours}`);
}

export function createLink(input: { device_a_id: string; device_b_id: string; interface_a?: string; interface_b?: string }) {
  return apiFetch<ManualLink>("/api/v1/topology/links", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteLink(id: string) {
  return apiFetch<void>(`/api/v1/topology/links/${id}`, { method: "DELETE" });
}
