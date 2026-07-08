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
