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

export interface FullTopologyDevice {
  id: string;
  name: string;
  device_type: string;
  status: string;
  x: number;
  y: number;
  open_alert_count: number;
  max_severity: string | null;
}

export interface FullTopologyLink {
  id: string;
  device_a_id: string;
  device_b_id: string;
  interface_a: string | null;
  interface_b: string | null;
}

// TÜM İLİŞKİLER (kullanıcı isteği): device_links (manuel bağlantılar) dışında,
// device_group üyeliklerini de (VMware'in otomatik senkronize ettiği "Tüm Host'lar"/
// "Cluster: X" grupları dahil) topoloji grafiğinde görsel kümeleme için kullanıyoruz.
export interface FullTopologyGroup {
  id: string;
  name: string;
  is_vmware_managed: boolean;
  member_device_ids: string[];
}

// TÜM İLİŞKİLER: vCenter/ESXi'den host'larına GÖRSEL hiyerarşi bağlantısı --
// device_links (manuel, kullanıcı tanımlı) İLE AYNI ŞEY DEĞİL.
export interface FullTopologyHierarchyLink {
  source_device_id: string;
  target_device_id: string;
}

// Gerçek NetFlow/sFlow verisinden (ClickHouse flows tablosu) otomatik hesaplanan
// trafik-bazlı kenarlar -- manuel bağlantılardan bağımsız, "hangi cihazlar
// GERÇEKTEN birbiriyle konuşuyor" bilgisi.
export interface FullTopologyTrafficEdge {
  device_a_id: string;
  device_b_id: string;
  total_bytes: number;
}

export function fetchFullTopology() {
  return apiFetch<{
    devices: FullTopologyDevice[]; links: FullTopologyLink[]; groups: FullTopologyGroup[];
    hierarchyLinks: FullTopologyHierarchyLink[]; trafficEdges: FullTopologyTrafficEdge[];
  }>("/api/v1/topology/full");
}

// TÜM İLİŞKİLER: "olası kök neden" analizi -- backend zaten hesaplıyordu
// (/devices/:id/diagnostics), ama sadece DeviceDetail'in İlişkiler sekmesinde
// metin olarak kullanılıyordu, topoloji grafiğinde GÖRSEL olarak hiç
// gösterilmiyordu.
export interface DeviceDiagnosticsTopologyNeighbor {
  id: string;
  name: string;
  open_alert_message: string | null;
  open_alert_triggered_at: string | null;
  open_alert_severity: string | null;
  likely_root_cause: boolean;
}

export function fetchDeviceDiagnostics(deviceId: string) {
  return apiFetch<{ topology_neighbors: DeviceDiagnosticsTopologyNeighbor[]; anchor_time: string | null }>(
    `/api/v1/devices/${deviceId}/diagnostics`
  );
}

export function saveTopologyPositions(positions: Array<{ device_id: string; x: number; y: number }>) {
  return apiFetch<{ success: boolean }>("/api/v1/topology/positions", {
    method: "PUT",
    body: JSON.stringify({ positions })
  });
}
