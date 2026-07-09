import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchUsers, fetchUserRoles, createUser, deleteUser } from "../../api/users";

export function useUsers() {
  return useQuery({ queryKey: ["users"], queryFn: fetchUsers });
}

export function useUserRoles() {
  return useQuery({ queryKey: ["user-roles"], queryFn: fetchUserRoles });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createUser,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] })
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteUser,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] })
  });
}

import { createUserRole, updateUserRole, deleteUserRole } from "../../api/users";

export function useCreateUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createUserRole,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-roles"] })
  });
}

export function useUpdateUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof updateUserRole>[1] }) => updateUserRole(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-roles"] })
  });
}

export function useDeleteUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteUserRole,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-roles"] })
  });
}
