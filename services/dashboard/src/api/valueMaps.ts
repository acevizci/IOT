import { apiFetch } from "./client";

export interface ValueMapMapping {
  value: string;
  label: string;
}

export interface ValueMap {
  id: string;
  name: string;
  mappings: ValueMapMapping[];
}

export function fetchValueMaps() {
  return apiFetch<ValueMap[]>("/api/v1/value-maps");
}

export function createValueMap(input: { name: string; mappings: ValueMapMapping[] }) {
  return apiFetch<ValueMap>("/api/v1/value-maps", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteValueMap(id: string) {
  return apiFetch<void>(`/api/v1/value-maps/${id}`, { method: "DELETE" });
}

export function setItemValueMap(itemId: string, valueMapId: string | null) {
  return apiFetch<any>(`/api/v1/template-items/${itemId}/value-map`, {
    method: "PATCH",
    body: JSON.stringify({ value_map_id: valueMapId })
  });
}
