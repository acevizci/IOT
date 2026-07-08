import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchDevices, fetchDeviceFacets, fetchDeviceTags,
  fetchDevice, createDevice, updateDevice, deleteDevice, bulkDeleteDevices, fetchLatestData
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
