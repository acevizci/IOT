import { apiFetch } from "./client";

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
  can_edit_devices: boolean;
  can_edit_alert_rules: boolean;
  can_manage_users: boolean;
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
