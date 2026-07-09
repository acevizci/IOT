import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchCredentials, createCredential, deleteCredential } from "../../api/credentials";

export function useCredentials() {
  return useQuery({ queryKey: ["credentials"], queryFn: fetchCredentials });
}

export function useCreateCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createCredential,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["credentials"] })
  });
}

export function useDeleteCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteCredential,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["credentials"] })
  });
}

import { updateCredential, fetchCredentialUsage } from "../../api/credentials";

export function useUpdateCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof updateCredential>[1] }) => updateCredential(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["credentials"] })
  });
}

export function useCredentialUsage(id: string) {
  return useQuery({
    queryKey: ["credential-usage", id],
    queryFn: () => fetchCredentialUsage(id),
    enabled: !!id
  });
}
