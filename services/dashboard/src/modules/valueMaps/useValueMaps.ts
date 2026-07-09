import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchValueMaps, createValueMap, deleteValueMap, setItemValueMap } from "../../api/valueMaps";

export function useValueMaps() {
  return useQuery({ queryKey: ["value-maps"], queryFn: fetchValueMaps });
}

export function useCreateValueMap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createValueMap,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["value-maps"] })
  });
}

export function useDeleteValueMap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteValueMap,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["value-maps"] })
  });
}

export function useSetItemValueMap(templateId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, valueMapId }: { itemId: string; valueMapId: string | null }) => setItemValueMap(itemId, valueMapId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["template-items", templateId] })
  });
}
