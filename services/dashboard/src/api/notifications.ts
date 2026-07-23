import { apiFetch } from "./client";

// Bildirim sistemi tasarımı: email tipi artık gerçek SMTP alanları taşıyor
// (host/port/secure/user/pass/from) -- önceden config her zaman {} gönderiliyordu,
// hiçbir e-posta kanalı çalışamıyordu. smtp_pass API yanıtında ASLA dönmez
// (macro'lardaki value_type='secret' ile AYNI desen) -- sadece has_smtp_password
// boolean'ı döner. webhook için "format": Slack/Teams'in beklediği payload şekli
// bizim sabit {device,severity,...} JSON'umuzla uyuşmuyordu (Slack "text" alanı
// yoksa mesajı hiç göstermez) -- format seçilince doğru şekilde üretilir.
export interface MediaTypeConfig {
  smtp_host?: string;
  smtp_port?: number;
  smtp_secure?: boolean;
  smtp_user?: string;
  smtp_pass?: string; // sadece YAZMA için (create/update body'sinde) -- API yanıtında hiç dönmez
  from?: string;
  format?: "generic" | "slack" | "teams";
  has_smtp_password?: boolean; // sadece OKUMA için (API yanıtında) -- şifre ayarlı mı
}

export interface MediaType {
  id: string;
  type: "email" | "webhook";
  name: string;
  config: MediaTypeConfig;
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

export function createMediaType(input: { type: "email" | "webhook"; name: string; config?: MediaTypeConfig }) {
  return apiFetch<MediaType>("/api/v1/media-types", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateMediaType(id: string, input: { name?: string; active?: boolean; config?: MediaTypeConfig }) {
  return apiFetch<MediaType>(`/api/v1/media-types/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function deleteMediaType(id: string) {
  return apiFetch<void>(`/api/v1/media-types/${id}`, { method: "DELETE" });
}

// Kullanıcı gerçek bir alarm oluşana kadar kanalın çalışıp çalışmadığını hiç
// öğrenemiyordu -- kanalın kendi hedefiyle DEĞİL, kullanıcının o an formda
// yazdığı hedefle test edilir (henüz user_media'ya kaydetmeden de denenebilsin).
export function testMediaType(id: string, destination: string) {
  return apiFetch<{ ok: true }>(`/api/v1/media-types/${id}/test`, {
    method: "POST",
    body: JSON.stringify({ destination })
  });
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
