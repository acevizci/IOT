import { apiFetch } from "./client";

export interface SyslogPattern {
  id: string;
  name: string;
  regex: string;
  metric_name: string;
  min_severity: number;
  enabled: boolean;
  created_at: string;
}

export interface SyslogPatternInput {
  name: string;
  regex: string;
  metric_name: string;
  min_severity: number;
  enabled: boolean;
}

export function fetchSyslogPatterns() {
  return apiFetch<SyslogPattern[]>("/api/v1/syslog-patterns");
}

export function createSyslogPattern(input: SyslogPatternInput) {
  return apiFetch<SyslogPattern>("/api/v1/syslog-patterns", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateSyslogPattern(id: string, input: SyslogPatternInput) {
  return apiFetch<SyslogPattern>(`/api/v1/syslog-patterns/${id}`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
}

export function deleteSyslogPattern(id: string) {
  return apiFetch<void>(`/api/v1/syslog-patterns/${id}`, { method: "DELETE" });
}
