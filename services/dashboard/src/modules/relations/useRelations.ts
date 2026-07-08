import { useQuery } from "@tanstack/react-query";
import { fetchDeviceRelations, fetchGroupAppliedTemplates } from "../../api/relations";

export function useDeviceRelations(deviceId: string) {
  return useQuery({
    queryKey: ["device-relations", deviceId],
    queryFn: () => fetchDeviceRelations(deviceId),
    enabled: !!deviceId
  });
}

export function useGroupAppliedTemplates(groupId: string) {
  return useQuery({
    queryKey: ["group-applied-templates", groupId],
    queryFn: () => fetchGroupAppliedTemplates(groupId),
    enabled: !!groupId
  });
}
