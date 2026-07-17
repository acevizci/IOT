import { apiFetch } from "./client";

export interface LdapConfig {
  id: string;
  host: string;
  port: number;
  bind_dn: string;
  base_dn: string;
  user_search_filter: string;
  use_tls: boolean;
  enabled: boolean;
}

export interface LdapConfigInput {
  host: string;
  port: number;
  bind_dn: string;
  bind_password: string;
  base_dn: string;
  user_search_filter: string;
  use_tls: boolean;
  enabled: boolean;
}

export function fetchLdapConfig() {
  return apiFetch<LdapConfig | null>("/api/v1/ldap-config");
}

export function upsertLdapConfig(input: LdapConfigInput) {
  return apiFetch<LdapConfig>("/api/v1/ldap-config", { method: "PUT", body: JSON.stringify(input) });
}

export function testLdapConfig() {
  return apiFetch<{ ok: boolean; message?: string; error?: string }>("/api/v1/ldap-config/test", { method: "POST" });
}
