import { apiFetch } from "./client";

// Bildirim sistemi tasarımı: email tipi artık gerçek SMTP alanları taşıyor
// (host/port/secure/user/pass/from) -- önceden config her zaman {} gönderiliyordu,
// hiçbir e-posta kanalı çalışamıyordu. smtp_pass API yanıtında ASLA dönmez
// (macro'lardaki value_type='secret' ile AYNI desen) -- sadece has_smtp_password
// boolean'ı döner. webhook için "format": Slack/Teams'in beklediği payload şekli
// bizim sabit {device,severity,...} JSON'umuzla uyuşmuyordu (Slack "text" alanı
// yoksa mesajı hiç göstermez) -- format seçilince doğru şekilde üretilir.
// PagerDuty: webhook'un 3. format'ı (Slack/Teams ile AYNI mantık, ayrı bir type DEĞİL) --
// "destination" gerçekte routing_key'dir, alarm-engine sabit bir URL'e postalar.
// SMS: genel HTTP SMS geçidi (Twilio'ya özel DEĞİL) -- kullanıcı kendi sağlayıcısının
// endpoint'ini yapılandırır. sms_auth_token smtp_pass ile AYNI şekilde asla API yanıtında
// dönmez (has_sms_auth_token boolean'ı döner).
export interface MediaTypeConfig {
  smtp_host?: string;
  smtp_port?: number;
  smtp_secure?: boolean;
  smtp_user?: string;
  smtp_pass?: string; // sadece YAZMA için (create/update body'sinde) -- API yanıtında hiç dönmez
  from?: string;
  format?: "generic" | "slack" | "teams" | "pagerduty";
  has_smtp_password?: boolean; // sadece OKUMA için (API yanıtında) -- şifre ayarlı mı
  sms_endpoint_url?: string;
  sms_method?: "GET" | "POST";
  sms_auth_header?: string;
  sms_auth_token?: string; // sadece YAZMA için -- API yanıtında hiç dönmez
  sms_body_template?: string;
  has_sms_auth_token?: boolean; // sadece OKUMA için
}

export type MediaTypeKind = "email" | "webhook" | "sms" | "webpush";

export interface MediaType {
  id: string;
  type: MediaTypeKind;
  name: string;
  config: MediaTypeConfig;
  active: boolean;
}

export interface UserMedia {
  id: string;
  destination: string;
  min_severity: string;
  active: boolean;
  media_type_id: string;
  media_type: string;
  media_type_name: string;
  device_group_id: string | null;
  device_group_name: string | null;
}

export function fetchMediaTypes() {
  return apiFetch<MediaType[]>("/api/v1/media-types");
}

export function createMediaType(input: { type: MediaTypeKind; name: string; config?: MediaTypeConfig }) {
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

// Mail Şablonları ("uçtan uca bildirim sistemi" turunun 1. parçası -- kullanıcıyla
// konuşulup kararlaştırıldı): mail içeriği önceden alarm-engine'de tamamen sabit
// kodlanmıştı, hiçbir şekilde değiştirilemiyordu. Her tenant'ın 3 senaryo (yeni
// alarm/çözüldü/eskalasyon) için kendi HTML+düz metin şablonu var.
export type EmailTemplateType = "new_alert" | "resolved_alert" | "escalation";

export interface EmailTemplate {
  id: string;
  template_type: EmailTemplateType;
  subject: string;
  body_html: string;
  body_text: string;
  updated_at: string;
}

export function fetchEmailTemplates() {
  return apiFetch<EmailTemplate[]>("/api/v1/email-templates");
}

export function updateEmailTemplate(id: string, input: { subject?: string; body_html?: string; body_text?: string }) {
  return apiFetch<EmailTemplate>(`/api/v1/email-templates/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function resetEmailTemplate(id: string) {
  return apiFetch<EmailTemplate>(`/api/v1/email-templates/${id}/reset`, { method: "POST" });
}

export function testEmailTemplate(id: string, mediaTypeId: string, destination: string) {
  return apiFetch<{ ok: true }>(`/api/v1/email-templates/${id}/test`, {
    method: "POST",
    body: JSON.stringify({ media_type_id: mediaTypeId, destination })
  });
}

// userId verilirse admin başka bir kullanıcının bildirim tercihlerini
// yönetiyor demektir (users:read_write gerektirir, core tarafında kontrol edilir).
export function fetchUserMedia(userId?: string) {
  return apiFetch<UserMedia[]>(`/api/v1/user-media${userId ? `?user_id=${userId}` : ""}`);
}

export function createUserMedia(input: {
  media_type_id: string;
  destination: string;
  device_group_id?: string | null;
  min_severity: string;
  user_id?: string;
}) {
  return apiFetch<UserMedia>("/api/v1/user-media", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateUserMedia(id: string, input: { destination?: string; device_group_id?: string | null; min_severity?: string }) {
  return apiFetch<UserMedia>(`/api/v1/user-media/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function deleteUserMedia(id: string) {
  return apiFetch<void>(`/api/v1/user-media/${id}`, { method: "DELETE" });
}
