import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchProxies,
  updateProxy,
  deleteProxy,
  testProxyConnection,
  fetchProxyRegistrationTokens,
  createProxyRegistrationToken,
  deleteProxyRegistrationToken
} from "../../api/proxies";

export function useProxies() {
  return useQuery({ queryKey: ["proxies"], queryFn: fetchProxies, refetchInterval: 30000 });
}

export function useUpdateProxy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof updateProxy>[1] }) => updateProxy(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["proxies"] })
  });
}

export function useDeleteProxy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteProxy(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["proxies"] })
  });
}

// Tek seferlik bir eylem (Dashboard'daki "Bağlantıyı Test Et" butonu) -- sonucu
// invalidate edilecek/cache'lenecek bir liste değil, çağıran bileşen kendi state'inde
// tutup anlık gösteriyor.
export function useTestProxyConnection() {
  return useMutation({ mutationFn: (id: string) => testProxyConnection(id) });
}

export function useProxyRegistrationTokens() {
  return useQuery({ queryKey: ["proxy-registration-tokens"], queryFn: fetchProxyRegistrationTokens });
}

export function useCreateProxyRegistrationToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createProxyRegistrationToken,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["proxy-registration-tokens"] })
  });
}

export function useDeleteProxyRegistrationToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteProxyRegistrationToken,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["proxy-registration-tokens"] })
  });
}
