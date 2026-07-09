import { apiFetch } from "./client";

export interface CollectorType {
  key: string;
  display_name: string;
  category: string;
  config_schema: { fields: string[] };
  handler_service: string;
}

export function fetchCollectorTypes() {
  return apiFetch<CollectorType[]>("/api/v1/collector-types");
}
