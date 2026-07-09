import { apiFetch } from "./client";

export interface DeviceCredential {
  id: string;
  name: string;
  credential_type: "ssh_password" | "ssh_key";
  username: string;
  created_at: string;
}

export function fetchCredentials() {
  return apiFetch<DeviceCredential[]>("/api/v1/device-credentials");
}

export function createCredential(input: { name: string; credential_type: "ssh_password" | "ssh_key"; username: string; secret: string }) {
  return apiFetch<DeviceCredential>("/api/v1/device-credentials", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteCredential(id: string) {
  return apiFetch<void>(`/api/v1/device-credentials/${id}`, { method: "DELETE" });
}

export function updateCredential(id: string, input: Partial<{ name: string; username: string; secret: string }>) {
  return apiFetch<DeviceCredential>(`/api/v1/device-credentials/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export interface CredentialUsage {
  item_id: string;
  metric_name: string;
  template_id: string;
  template_name: string;
}

export function fetchCredentialUsage(id: string) {
  return apiFetch<CredentialUsage[]>(`/api/v1/device-credentials/${id}/usage`);
}
