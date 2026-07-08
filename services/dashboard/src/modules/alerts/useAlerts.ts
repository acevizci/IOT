import { useQuery } from "@tanstack/react-query";
import { fetchAlerts } from "../../api/alerts";

export function useAlerts(status?: "open" | "resolved") {
  return useQuery({
    queryKey: ["alerts", status],
    queryFn: () => fetchAlerts(status),
    refetchInterval: 20000
  });
}

import { fetchSuppressedAlerts } from "../../api/alerts";

export function useSuppressedAlerts() {
  return useQuery({
    queryKey: ["suppressed-alerts"],
    queryFn: fetchSuppressedAlerts,
    refetchInterval: 20000
  });
}
