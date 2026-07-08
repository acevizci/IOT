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
