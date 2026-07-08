import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchMacros, createMacro, deleteMacro, fetchMacroOverrides, createMacroOverride, deleteMacroOverride } from "../../api/macros";

export function useMacros() {
  return useQuery({ queryKey: ["macros"], queryFn: fetchMacros });
}

export function useCreateMacro() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createMacro,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["macros"] })
  });
}

export function useDeleteMacro() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteMacro,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["macros"] })
  });
}

export function useMacroOverrides(macroId: string) {
  return useQuery({
    queryKey: ["macro-overrides", macroId],
    queryFn: () => fetchMacroOverrides(macroId),
    enabled: !!macroId
  });
}

export function useCreateMacroOverride(macroId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof createMacroOverride>[1]) => createMacroOverride(macroId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["macro-overrides", macroId] })
  });
}

export function useDeleteMacroOverride(macroId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (overrideId: string) => deleteMacroOverride(macroId, overrideId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["macro-overrides", macroId] })
  });
}
