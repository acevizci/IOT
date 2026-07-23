import { apiFetch } from "./client";

export type PermissionLevel = "none" | "read" | "read_write";
export type PermissionMap = Record<string, PermissionLevel>;

// FAZ 1 dashboard menü bölümleriyle birebir eşleşen kaynak listesi (bkz. core
// services/core/src/index.ts ALL_RESOURCES).
export const ALL_RESOURCES: { key: string; label: string }[] = [
  { key: "devices", label: "Cihazlar" },
  { key: "device_groups", label: "Cihaz grupları" },
  { key: "templates", label: "Şablonlar" },
  { key: "alert_rules", label: "Alarm kuralları" },
  { key: "maintenance", label: "Bakım pencereleri" },
  { key: "webscenarios", label: "Web senaryoları" },
  { key: "queue", label: "Kuyruk" },
  { key: "users", label: "Kullanıcılar" },
  { key: "user_roles", label: "Roller" },
  { key: "user_groups", label: "Kullanıcı grupları" },
  { key: "agent_releases", label: "Agent sürümleri" },
  { key: "audit_log", label: "Denetim kaydı" },
  { key: "dashboards", label: "Dashboard'lar" },
  { key: "macros", label: "Makrolar" },
  { key: "value_maps", label: "Value maps" },
  { key: "topology", label: "Topoloji" },
  { key: "relations", label: "İlişkiler" },
  { key: "notifications", label: "Bildirim kanalları" },
  { key: "geo_map", label: "Harita" }
];

export interface AppUser {
  id: string;
  email: string;
  created_at: string;
  role_id: string | null;
  role_name: string | null;
}

export interface UserRole {
  id: string;
  name: string;
  permissions: PermissionMap;
}

export function fetchUsers() {
  return apiFetch<AppUser[]>("/api/v1/users");
}

export function fetchUserRoles() {
  return apiFetch<UserRole[]>("/api/v1/user-roles");
}

export function createUser(input: { email: string; password: string; role_id: string }) {
  return apiFetch<AppUser>("/api/v1/users", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteUser(id: string) {
  return apiFetch<void>(`/api/v1/users/${id}`, { method: "DELETE" });
}

export function createUserRole(input: { name: string; permissions: PermissionMap }) {
  return apiFetch<UserRole>("/api/v1/user-roles", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateUserRole(id: string, input: Partial<{ name: string; permissions: PermissionMap }>) {
  return apiFetch<UserRole>(`/api/v1/user-roles/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function deleteUserRole(id: string) {
  return apiFetch<void>(`/api/v1/user-roles/${id}`, { method: "DELETE" });
}
