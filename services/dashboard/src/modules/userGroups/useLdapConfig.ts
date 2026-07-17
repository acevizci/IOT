import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchLdapConfig, upsertLdapConfig, testLdapConfig } from "../../api/ldapConfig";

export function useLdapConfig() {
  return useQuery({ queryKey: ["ldap-config"], queryFn: fetchLdapConfig });
}

export function useUpsertLdapConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: upsertLdapConfig,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ldap-config"] })
  });
}

export function useTestLdapConfig() {
  return useMutation({ mutationFn: testLdapConfig });
}
