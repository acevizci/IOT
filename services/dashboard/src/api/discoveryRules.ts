import { apiFetch } from "./client";

export type SnmpVersion = "v2c" | "v3";
export type SnmpV3Level = "noAuthNoPriv" | "authNoPriv" | "authPriv";
export type SnmpAuthProtocol = "md5" | "sha" | "sha224" | "sha256" | "sha384" | "sha512";
export type SnmpPrivProtocol = "des" | "aes" | "aes256b" | "aes256r";

export interface DiscoveryRule {
  id: string;
  name: string;
  cidr_ranges: string[];
  snmp_version: SnmpVersion;
  snmp_community: string | null;
  snmp_v3_username: string | null;
  snmp_v3_level: SnmpV3Level | null;
  snmp_v3_auth_protocol: SnmpAuthProtocol | null;
  snmp_v3_priv_protocol: SnmpPrivProtocol | null;
  // NULL = sadece manuel ("Şimdi çalıştır"); dolu = otomatik periyodik tarama.
  schedule_interval_hours: number | null;
  last_run_at: string | null;
  active: boolean;
  created_at: string;
}

export interface DiscoveryRuleV3Input {
  username: string;
  level: SnmpV3Level;
  authProtocol?: SnmpAuthProtocol;
  authKey?: string;
  privProtocol?: SnmpPrivProtocol;
  privKey?: string;
}

export interface DiscoveryRuleInput {
  name: string;
  cidr_ranges: string[];
  snmp_version: SnmpVersion;
  snmp_community?: string;
  snmp_v3?: DiscoveryRuleV3Input;
  schedule_interval_hours?: number | null;
  active?: boolean;
}

export function fetchDiscoveryRules() {
  return apiFetch<DiscoveryRule[]>("/api/v1/discovery-rules");
}

export function createDiscoveryRule(input: DiscoveryRuleInput) {
  return apiFetch<DiscoveryRule>("/api/v1/discovery-rules", { method: "POST", body: JSON.stringify(input) });
}

export function updateDiscoveryRule(id: string, input: Partial<DiscoveryRuleInput>) {
  return apiFetch<DiscoveryRule>(`/api/v1/discovery-rules/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteDiscoveryRule(id: string) {
  return apiFetch<void>(`/api/v1/discovery-rules/${id}`, { method: "DELETE" });
}

export function runDiscoveryRule(id: string) {
  return apiFetch<{ jobId: string; total: number }>(`/api/v1/discovery-rules/${id}/run`, { method: "POST" });
}

export interface ScanResult {
  ip: string;
  reachable: boolean;
  sysDescr?: string;
  interfaceCount?: number;
}

export interface ScanJob {
  jobId: string;
  status: "running" | "completed" | "failed";
  // FAZ 1 (ping): tüm aralık hızlıca taranır. FAZ 2 (snmp): sadece canlı host'larda.
  phase: "ping" | "snmp";
  pingTotal: number;
  pingScanned: number;
  snmpTotal: number;
  snmpScanned: number;
  found: ScanResult[];
  startedAt: string;
  completedAt?: string;
  error?: string;
}

// Not: gateway /api/v1/discovery/* prefix'ini doğrudan npm-service'e proxy'liyor
// (job state hiçbir kimlik bilgisi taşımıyor, jobId zaten tahmin edilemez bir UUID).
export function fetchScanJob(jobId: string) {
  return apiFetch<ScanJob>(`/api/v1/discovery/scan/${jobId}`);
}

export interface DiscoveryCandidate {
  id: string;
  ip_address: string;
  sys_descr: string | null;
  interface_count: number | null;
  first_seen_at: string;
  last_seen_at: string;
  rule_id: string | null;
  rule_name: string | null;
  snmp_version: SnmpVersion | null;
}

export function fetchDiscoveryCandidates() {
  return apiFetch<DiscoveryCandidate[]>("/api/v1/discovery-candidates");
}

export function dismissDiscoveryCandidate(id: string) {
  return apiFetch<void>(`/api/v1/discovery-candidates/${id}/dismiss`, { method: "POST" });
}

export function bulkAddDiscoveryCandidates(ids: string[], deviceType: string) {
  return apiFetch<{ created: { id: string; name: string; ip_address: string }[]; failed: { ip_address: string; error: string }[] }>(
    "/api/v1/discovery-candidates/bulk-add",
    { method: "POST", body: JSON.stringify({ ids, device_type: deviceType }) }
  );
}
