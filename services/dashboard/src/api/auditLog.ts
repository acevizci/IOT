import { apiFetch } from "./client";

export interface AuditLogEntry {
  id: string;
  user_email: string;
  method: string;
  path: string;
  status_code: number;
  created_at: string;
}

export function fetchAuditLog() {
  return apiFetch<AuditLogEntry[]>("/api/v1/audit-log");
}
