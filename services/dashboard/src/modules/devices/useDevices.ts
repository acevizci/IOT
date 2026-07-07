import { useQuery } from "@tanstack/react-query";
import { fetchDevices } from "../../api/devices";
import type { DeviceListParams } from "../../api/devices";

export function useDevices(params: DeviceListParams) {
  return useQuery({
    queryKey: ["devices", params],
    queryFn: () => fetchDevices(params),
    refetchInterval: 30000
  });
}

import { fetchDeviceFacets } from "../../api/devices";

export function useDeviceFacets() {
  return useQuery({ queryKey: ["device-facets"], queryFn: fetchDeviceFacets });
}
