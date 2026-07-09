import { apiFetch } from "./client";
import type { PaginatedResult } from "./devices";

export interface AuditLogEntry {
  id: string;
  user_email: string;
  method: string;
  path: string;
  status_code: number;
  request_body: Record<string, any> | null;
  response_body: Record<string, any> | null;
  created_at: string;
}

export interface AuditLogFilters {
  user_email?: string;
  method?: string;
  page?: number;
  limit?: number;
}

export function fetchAuditLog(filters: AuditLogFilters = {}) {
  const query = new URLSearchParams();
  if (filters.user_email) query.set("user_email", filters.user_email);
  if (filters.method) query.set("method", filters.method);
  query.set("page", String(filters.page ?? 1));
  query.set("limit", String(filters.limit ?? 50));
  return apiFetch<PaginatedResult<AuditLogEntry>>(`/api/v1/audit-log?${query.toString()}`);
}
