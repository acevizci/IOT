import { apiFetch } from "./client";

export interface DeviceGroup {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  member_count?: number;
  is_vmware_managed?: boolean;
}

export interface DeviceGroupDetail extends DeviceGroup {
  members: Array<{ id: string; name: string; ip_address: string; device_type: string; status: string }>;
}

export function fetchDeviceGroups() {
  return apiFetch<DeviceGroup[]>("/api/v1/device-groups");
}

export function fetchDeviceGroup(id: string) {
  return apiFetch<DeviceGroupDetail>(`/api/v1/device-groups/${id}`);
}

export function createDeviceGroup(input: { name: string; description?: string }) {
  return apiFetch<DeviceGroup>("/api/v1/device-groups", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteDeviceGroup(id: string) {
  return apiFetch<void>(`/api/v1/device-groups/${id}`, { method: "DELETE" });
}

export function addGroupMembers(groupId: string, deviceIds: string[]) {
  return apiFetch<{ added: number }>(`/api/v1/device-groups/${groupId}/members`, {
    method: "POST",
    body: JSON.stringify({ device_ids: deviceIds })
  });
}

export function removeGroupMember(groupId: string, deviceId: string) {
  return apiFetch<void>(`/api/v1/device-groups/${groupId}/members/${deviceId}`, { method: "DELETE" });
}
