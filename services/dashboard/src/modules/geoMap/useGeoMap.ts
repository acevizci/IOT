import { useQuery } from "@tanstack/react-query";
import { fetchDeviceMapLocations } from "../../api/devices";

export function useDeviceMapLocations() {
  return useQuery({
    queryKey: ["device-map-locations"],
    queryFn: fetchDeviceMapLocations,
    refetchInterval: 30000
  });
}
