import { useQuery } from "@tanstack/react-query";
import { fetchCollectorTypes } from "../../api/collectorTypes";

export function useCollectorTypes() {
  return useQuery({ queryKey: ["collector-types"], queryFn: fetchCollectorTypes });
}
