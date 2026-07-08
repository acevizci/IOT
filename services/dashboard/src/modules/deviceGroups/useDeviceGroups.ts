import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchDeviceGroups, fetchDeviceGroup, createDeviceGroup, deleteDeviceGroup,
  addGroupMembers, removeGroupMember
} from "../../api/deviceGroups";

export function useDeviceGroups() {
  return useQuery({ queryKey: ["device-groups"], queryFn: fetchDeviceGroups });
}

export function useDeviceGroup(id: string) {
  return useQuery({
    queryKey: ["device-group", id],
    queryFn: () => fetchDeviceGroup(id),
    enabled: !!id
  });
}

export function useCreateDeviceGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createDeviceGroup,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["device-groups"] })
  });
}

export function useDeleteDeviceGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteDeviceGroup,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["device-groups"] })
  });
}

export function useAddGroupMembers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, deviceIds }: { groupId: string; deviceIds: string[] }) => addGroupMembers(groupId, deviceIds),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["device-group", variables.groupId] });
      qc.invalidateQueries({ queryKey: ["device-groups"] });
    }
  });
}

export function useRemoveGroupMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, deviceId }: { groupId: string; deviceId: string }) => removeGroupMember(groupId, deviceId),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["device-group", variables.groupId] });
      qc.invalidateQueries({ queryKey: ["device-groups"] });
    }
  });
}
