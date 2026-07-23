import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchMediaTypes, createMediaType, updateMediaType, deleteMediaType, testMediaType,
  fetchUserMedia, createUserMedia, deleteUserMedia,
  fetchEmailTemplates, updateEmailTemplate, resetEmailTemplate, testEmailTemplate
} from "../../api/notifications";

export function useMediaTypes() {
  return useQuery({ queryKey: ["media-types"], queryFn: fetchMediaTypes });
}

export function useCreateMediaType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createMediaType,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["media-types"] })
  });
}

export function useUpdateMediaType(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof updateMediaType>[1]) => updateMediaType(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["media-types"] })
  });
}

export function useDeleteMediaType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteMediaType,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["media-types"] })
  });
}

export function useTestMediaType(id: string) {
  return useMutation({
    mutationFn: (destination: string) => testMediaType(id, destination)
  });
}

export function useUserMedia() {
  return useQuery({ queryKey: ["user-media"], queryFn: fetchUserMedia });
}

export function useCreateUserMedia() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createUserMedia,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-media"] })
  });
}

export function useDeleteUserMedia() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteUserMedia,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-media"] })
  });
}

export function useEmailTemplates() {
  return useQuery({ queryKey: ["email-templates"], queryFn: fetchEmailTemplates });
}

export function useUpdateEmailTemplate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof updateEmailTemplate>[1]) => updateEmailTemplate(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-templates"] })
  });
}

export function useResetEmailTemplate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => resetEmailTemplate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-templates"] })
  });
}

export function useTestEmailTemplate(id: string) {
  return useMutation({
    mutationFn: ({ mediaTypeId, destination }: { mediaTypeId: string; destination: string }) => testEmailTemplate(id, mediaTypeId, destination)
  });
}
