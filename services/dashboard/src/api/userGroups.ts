import { apiFetch } from "./client";

export interface UserGroup {
  id: string;
  name: string;
  frontend_access: "system_default" | "internal" | "ldap" | "disabled";
  enabled: boolean;
  debug_mode: boolean;
  member_count?: number;
}

export interface UserGroupMember {
  id: string;
  email: string;
}

export interface DeviceGroupPermission {
  id: string;
  device_group_id: string;
  device_group_name: string;
  permission: "read" | "read_write" | "deny";
}

export interface TagFilter {
  id: string;
  device_group_id: string;
  device_group_name: string;
  tag: string;
  value: string | null;
}

export function fetchUserGroups() {
  return apiFetch<UserGroup[]>("/api/v1/user-groups");
}

export function createUserGroup(input: { name: string; frontend_access?: string; enabled?: boolean; debug_mode?: boolean }) {
  return apiFetch<UserGroup>("/api/v1/user-groups", { method: "POST", body: JSON.stringify(input) });
}

export function updateUserGroup(id: string, input: Partial<{ name: string; frontend_access: string; enabled: boolean; debug_mode: boolean }>) {
  return apiFetch<UserGroup>(`/api/v1/user-groups/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteUserGroup(id: string) {
  return apiFetch<void>(`/api/v1/user-groups/${id}`, { method: "DELETE" });
}

export function fetchGroupMembers(groupId: string) {
  return apiFetch<UserGroupMember[]>(`/api/v1/user-groups/${groupId}/members`);
}

export function addGroupMember(groupId: string, userId: string) {
  return apiFetch<{ ok: boolean }>(`/api/v1/user-groups/${groupId}/members`, {
    method: "POST",
    body: JSON.stringify({ user_id: userId })
  });
}

export function removeGroupMember(groupId: string, userId: string) {
  return apiFetch<void>(`/api/v1/user-groups/${groupId}/members/${userId}`, { method: "DELETE" });
}

export function fetchGroupDevicePermissions(groupId: string) {
  return apiFetch<DeviceGroupPermission[]>(`/api/v1/user-groups/${groupId}/device-permissions`);
}

export function setGroupDevicePermission(groupId: string, deviceGroupId: string, permission: "read" | "read_write" | "deny") {
  return apiFetch<DeviceGroupPermission>(`/api/v1/user-groups/${groupId}/device-permissions`, {
    method: "POST",
    body: JSON.stringify({ device_group_id: deviceGroupId, permission })
  });
}

export function deleteGroupDevicePermission(groupId: string, permissionId: string) {
  return apiFetch<void>(`/api/v1/user-groups/${groupId}/device-permissions/${permissionId}`, { method: "DELETE" });
}

export function fetchGroupTagFilters(groupId: string) {
  return apiFetch<TagFilter[]>(`/api/v1/user-groups/${groupId}/tag-filters`);
}

export function setGroupTagFilter(groupId: string, deviceGroupId: string, tag: string, value?: string) {
  return apiFetch<TagFilter>(`/api/v1/user-groups/${groupId}/tag-filters`, {
    method: "POST",
    body: JSON.stringify({ device_group_id: deviceGroupId, tag, value })
  });
}

export function deleteGroupTagFilter(groupId: string, filterId: string) {
  return apiFetch<void>(`/api/v1/user-groups/${groupId}/tag-filters/${filterId}`, { method: "DELETE" });
}
