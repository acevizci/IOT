import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchTenants, createTenant, deleteTenant } from "../../api/tenants";

export function useTenants() {
  return useQuery({ queryKey: ["superadmin-tenants"], queryFn: fetchTenants });
}

export function useCreateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createTenant,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["superadmin-tenants"] })
  });
}

export function useDeleteTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteTenant,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["superadmin-tenants"] })
  });
}
