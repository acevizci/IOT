import { useQuery } from "@tanstack/react-query";
import { fetchAuditLog } from "../../api/auditLog";

export function useAuditLog() {
  return useQuery({ queryKey: ["audit-log"], queryFn: fetchAuditLog, refetchInterval: 15000 });
}
