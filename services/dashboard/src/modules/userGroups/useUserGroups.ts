import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchUserGroups, createUserGroup, updateUserGroup, deleteUserGroup,
  fetchGroupMembers, addGroupMember, removeGroupMember,
  fetchGroupDevicePermissions, setGroupDevicePermission, deleteGroupDevicePermission,
  fetchGroupTagFilters, setGroupTagFilter, deleteGroupTagFilter
} from "../../api/userGroups";

export function useUserGroups() {
  return useQuery({ queryKey: ["user-groups"], queryFn: fetchUserGroups });
}

export function useCreateUserGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createUserGroup,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-groups"] })
  });
}

export function useUpdateUserGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof updateUserGroup>[1] }) => updateUserGroup(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-groups"] })
  });
}

export function useDeleteUserGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteUserGroup,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-groups"] })
  });
}

export function useGroupMembers(groupId: string) {
  return useQuery({
    queryKey: ["user-group-members", groupId],
    queryFn: () => fetchGroupMembers(groupId),
    enabled: !!groupId
  });
}

export function useAddGroupMember(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => addGroupMember(groupId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-group-members", groupId] });
      qc.invalidateQueries({ queryKey: ["user-groups"] });
    }
  });
}

export function useRemoveGroupMember(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => removeGroupMember(groupId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["user-group-members", groupId] });
      qc.invalidateQueries({ queryKey: ["user-groups"] });
    }
  });
}

export function useGroupDevicePermissions(groupId: string) {
  return useQuery({
    queryKey: ["user-group-device-permissions", groupId],
    queryFn: () => fetchGroupDevicePermissions(groupId),
    enabled: !!groupId
  });
}

export function useSetGroupDevicePermission(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ deviceGroupId, permission }: { deviceGroupId: string; permission: "read" | "read_write" | "deny" }) =>
      setGroupDevicePermission(groupId, deviceGroupId, permission),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-group-device-permissions", groupId] })
  });
}

export function useDeleteGroupDevicePermission(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (permissionId: string) => deleteGroupDevicePermission(groupId, permissionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-group-device-permissions", groupId] })
  });
}

export function useGroupTagFilters(groupId: string) {
  return useQuery({
    queryKey: ["user-group-tag-filters", groupId],
    queryFn: () => fetchGroupTagFilters(groupId),
    enabled: !!groupId
  });
}

export function useSetGroupTagFilter(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ deviceGroupId, tag, value }: { deviceGroupId: string; tag: string; value?: string }) =>
      setGroupTagFilter(groupId, deviceGroupId, tag, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-group-tag-filters", groupId] })
  });
}

export function useDeleteGroupTagFilter(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (filterId: string) => deleteGroupTagFilter(groupId, filterId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-group-tag-filters", groupId] })
  });
}
