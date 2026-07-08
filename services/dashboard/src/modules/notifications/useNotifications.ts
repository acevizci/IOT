import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchMediaTypes, createMediaType, deleteMediaType,
  fetchUserMedia, createUserMedia, deleteUserMedia
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

export function useDeleteMediaType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteMediaType,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["media-types"] })
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
