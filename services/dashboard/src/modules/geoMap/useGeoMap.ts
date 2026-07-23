import { useQuery } from "@tanstack/react-query";
import { fetchDeviceMapLocations } from "../../api/devices";
import type { DeviceMapLocationFilter } from "../../api/devices";

export function useDeviceMapLocations(filter?: DeviceMapLocationFilter, refetchInterval: number | false = 30000) {
  return useQuery({
    queryKey: ["device-map-locations", filter],
    queryFn: () => fetchDeviceMapLocations(filter),
    refetchInterval
  });
}
