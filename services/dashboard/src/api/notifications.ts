import { apiFetch } from "./client";

export interface MediaType {
  id: string;
  type: "email" | "webhook";
  name: string;
  config: Record<string, any>;
  active: boolean;
}

export interface UserMedia {
  id: string;
  destination: string;
  min_severity: string;
  active: boolean;
  media_type: string;
  media_type_name: string;
  device_group_name: string | null;
}

export function fetchMediaTypes() {
  return apiFetch<MediaType[]>("/api/v1/media-types");
}

export function createMediaType(input: { type: "email" | "webhook"; name: string; config?: Record<string, any> }) {
  return apiFetch<MediaType>("/api/v1/media-types", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteMediaType(id: string) {
  return apiFetch<void>(`/api/v1/media-types/${id}`, { method: "DELETE" });
}

export function fetchUserMedia() {
  return apiFetch<UserMedia[]>("/api/v1/user-media");
}

export function createUserMedia(input: {
  media_type_id: string;
  destination: string;
  device_group_id?: string | null;
  min_severity: string;
}) {
  return apiFetch<UserMedia>("/api/v1/user-media", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteUserMedia(id: string) {
  return apiFetch<void>(`/api/v1/user-media/${id}`, { method: "DELETE" });
}
