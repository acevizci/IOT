import { apiFetch } from "./client";

export interface DiscoveryResult {
  reachable: boolean;
  sysDescr?: string;
  interfaceCount?: number;
  interfaceNames?: string[];
  error?: string;
}

// Tek bir IP için hızlı SNMP bağlantı testi (örn. cihaz ekleme formunda
// "bağlantıyı test et"). Aralık taraması artık kural-bazlı -- bkz. api/discoveryRules.ts.
export function discoverDevice(ipAddress: string, community: string) {
  return apiFetch<DiscoveryResult>("/api/v1/discovery/device", {
    method: "POST",
    body: JSON.stringify({ ip_address: ipAddress, community })
  });
}
