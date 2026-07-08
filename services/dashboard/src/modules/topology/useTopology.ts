import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchTopology, createLink, deleteLink } from "../../api/topology";

export function useTopology(hours: number) {
  return useQuery({
    queryKey: ["topology", hours],
    queryFn: () => fetchTopology(hours),
    refetchInterval: 20000
  });
}

export function useCreateLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createLink,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["topology"] })
  });
}

export function useDeleteLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteLink,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["topology"] })
  });
}
