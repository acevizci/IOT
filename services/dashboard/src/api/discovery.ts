import { apiFetch } from "./client";

export interface DiscoveryResult {
  reachable: boolean;
  sysDescr?: string;
  interfaceCount?: number;
  interfaceNames?: string[];
  error?: string;
}

export function discoverDevice(ipAddress: string, community: string) {
  return apiFetch<DiscoveryResult>("/api/v1/discovery/device", {
    method: "POST",
    body: JSON.stringify({ ip_address: ipAddress, community })
  });
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
  total: number;
  scanned: number;
  found: ScanResult[];
  startedAt: string;
  completedAt?: string;
}

export function startSubnetScan(cidr: string, community: string) {
  return apiFetch<{ jobId: string; total: number }>("/api/v1/discovery/scan", {
    method: "POST",
    body: JSON.stringify({ cidr, community })
  });
}

export function fetchScanJob(jobId: string) {
  return apiFetch<ScanJob>(`/api/v1/discovery/scan/${jobId}`);
}
