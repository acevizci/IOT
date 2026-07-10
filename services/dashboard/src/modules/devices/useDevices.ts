import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchDevices, fetchDeviceFacets, fetchDeviceTags,
  fetchDevice, createDevice, updateDevice, deleteDevice, bulkDeleteDevices, fetchLatestData,
  bulkAssignGroup, bulkAssignTemplate, fetchDeviceDiagnostics
} from "../../api/devices";
import type { DeviceListParams } from "../../api/devices";

export function useDevices(params: DeviceListParams) {
  return useQuery({
    queryKey: ["devices", params],
    queryFn: () => fetchDevices(params),
    refetchInterval: 30000
  });
}

export function useDevice(id: string) {
  return useQuery({
    queryKey: ["device", id],
    queryFn: () => fetchDevice(id),
    enabled: !!id
  });
}

export function useDeviceFacets() {
  return useQuery({ queryKey: ["device-facets"], queryFn: fetchDeviceFacets });
}

export function useDeviceTags() {
  return useQuery({ queryKey: ["device-tags"], queryFn: fetchDeviceTags });
}

export function useLatestData(deviceId: string) {
  return useQuery({
    queryKey: ["latest-data", deviceId],
    queryFn: () => fetchLatestData(deviceId),
    enabled: !!deviceId,
    refetchInterval: 20000
  });
}

function invalidateDeviceQueries(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["devices"] });
  qc.invalidateQueries({ queryKey: ["device-facets"] });
  qc.invalidateQueries({ queryKey: ["device-tags"] });
}

export function useCreateDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createDevice,
    onSuccess: () => invalidateDeviceQueries(qc)
  });
}

export function useUpdateDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof updateDevice>[1] }) => updateDevice(id, input),
    onSuccess: (_data, variables) => {
      invalidateDeviceQueries(qc);
      qc.invalidateQueries({ queryKey: ["device", variables.id] });
    }
  });
}

export function useDeleteDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteDevice,
    onSuccess: () => invalidateDeviceQueries(qc)
  });
}

export function useBulkDeleteDevices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: bulkDeleteDevices,
    onSuccess: () => invalidateDeviceQueries(qc)
  });
}

import { fetchDeviceTemplates, assignDeviceTemplate, removeDeviceTemplate } from "../../api/devices";

export function useDeviceTemplates(deviceId: string) {
  return useQuery({
    queryKey: ["device-templates", deviceId],
    queryFn: () => fetchDeviceTemplates(deviceId),
    enabled: !!deviceId
  });
}

export function useAssignDeviceTemplate(deviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) => assignDeviceTemplate(deviceId, templateId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["device-templates", deviceId] })
  });
}

export function useRemoveDeviceTemplate(deviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) => removeDeviceTemplate(deviceId, templateId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["device-templates", deviceId] })
  });
}


export function useBulkAssignGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ deviceIds, groupId }: { deviceIds: string[]; groupId: string }) => bulkAssignGroup(deviceIds, groupId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["device-groups"] })
  });
}

export function useBulkAssignTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ deviceIds, templateId }: { deviceIds: string[]; templateId: string }) => bulkAssignTemplate(deviceIds, templateId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-templates"] })
  });
}

export function useDeviceDiagnostics(deviceId: string) {
  return useQuery({
    queryKey: ["device-diagnostics", deviceId],
    queryFn: () => fetchDeviceDiagnostics(deviceId),
    enabled: !!deviceId,
    refetchInterval: 20000
  });
}

import { fetchNeededCollectorTypes } from "../../api/devices";

export function useNeededCollectorTypes(deviceId: string) {
  return useQuery({
    queryKey: ["needed-collector-types", deviceId],
    queryFn: () => fetchNeededCollectorTypes(deviceId),
    enabled: !!deviceId
  });
}

import { fetchDeviceUsedMacros } from "../../api/devices";

export function useDeviceUsedMacros(deviceId: string) {
  return useQuery({
    queryKey: ["device-used-macros", deviceId],
    queryFn: () => fetchDeviceUsedMacros(deviceId),
    enabled: !!deviceId
  });
}

import { createMacroOverride } from "../../api/macros";

export function useSetDeviceMacroOverride(deviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ macroId, value }: { macroId: string; value: string }) =>
      createMacroOverride(macroId, { scope_type: "device", scope_id: deviceId, value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["device-used-macros", deviceId] })
  });
}
