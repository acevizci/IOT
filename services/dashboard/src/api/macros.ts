import { apiFetch } from "./client";

export type MacroValueType = "numeric" | "string" | "secret";

export interface Macro {
  id: string;
  key: string;
  value_type: MacroValueType;
  default_value: string;
  description: string | null;
}

export interface MacroOverride {
  id: string;
  scope_type: "device" | "device_group";
  scope_id: string;
  value: string;
  scope_name: string;
}

export function fetchMacros() {
  return apiFetch<Macro[]>("/api/v1/macros");
}

export function createMacro(input: { key: string; value_type: MacroValueType; default_value: string; description?: string }) {
  return apiFetch<Macro>("/api/v1/macros", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteMacro(id: string) {
  return apiFetch<void>(`/api/v1/macros/${id}`, { method: "DELETE" });
}

export function fetchMacroOverrides(macroId: string) {
  return apiFetch<MacroOverride[]>(`/api/v1/macros/${macroId}/overrides`);
}

export function createMacroOverride(macroId: string, input: { scope_type: "device" | "device_group"; scope_id: string; value: string }) {
  return apiFetch<MacroOverride>(`/api/v1/macros/${macroId}/overrides`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteMacroOverride(macroId: string, overrideId: string) {
  return apiFetch<void>(`/api/v1/macros/${macroId}/overrides/${overrideId}`, { method: "DELETE" });
}
