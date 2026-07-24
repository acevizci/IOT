import { apiFetch } from "./client";

// Platform superadmin: mevcut tenant-scoped permission modelinden TAMAMEN AYRI --
// bu uçlar SADECE users.is_superadmin=true olan hesaplara açık (bkz. core-service
// requireSuperadmin). Normal bir tenant Admin'i bunları göremez/çağıramaz.
export interface Tenant {
  id: string;
  name: string;
  plan: string;
  created_at: string;
  user_count: number;
  device_count: number;
  proxy_count: number;
}

export function fetchTenants() {
  return apiFetch<Tenant[]>("/api/v1/superadmin/tenants");
}

export function createTenant(input: { tenantName: string; email: string; password: string }) {
  return apiFetch<{ tenantId: string; adminUser: { id: string; email: string } }>("/api/v1/superadmin/tenants", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteTenant(id: string) {
  return apiFetch<void>(`/api/v1/superadmin/tenants/${id}`, { method: "DELETE" });
}
