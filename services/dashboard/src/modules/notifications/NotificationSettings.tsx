import { useState } from "react";
import { Plus, Trash2, Mail, Webhook, MessageSquare, BellRing, Pencil, Send, Check, X, RotateCcw } from "lucide-react";
import {
  useMediaTypes, useCreateMediaType, useUpdateMediaType, useDeleteMediaType, useTestMediaType,
  useUserMedia, useCreateUserMedia, useUpdateUserMedia, useDeleteUserMedia,
  useEmailTemplates, useUpdateEmailTemplate, useResetEmailTemplate, useTestEmailTemplate
} from "./useNotifications";
import { useDeviceGroups } from "../deviceGroups/useDeviceGroups";
import { SEVERITY_LEVELS, SEVERITY_LABEL } from "../shared/severity";
import type { MediaType, MediaTypeConfig, MediaTypeKind, UserMedia, EmailTemplate, EmailTemplateType } from "../../api/notifications";
import { EscalationPoliciesTab } from "../escalationPolicies/EscalationPoliciesTab";
import { OnCallSchedulesTab } from "../oncallSchedules/OnCallSchedulesTab";
import { WebPushSubscribeButton } from "./WebPushSubscribeButton";

const MEDIA_TYPE_LABEL: Record<MediaTypeKind, string> = {
  email: "E-posta (SMTP)",
  webhook: "Webhook",
  sms: "SMS (HTTP geçidi)",
  webpush: "Tarayıcı Push"
};

// Kullanıcı kararı: Kanallar ve Eskalasyon Politikaları ayrı üst-seviye
// sayfalar OLMASIN -- ikisi de aynı "bildirim sistemi"nin parçası (bir
// politika adımı bir kanalı referans eder), DeviceDetail'in Kurallar/Makrolar
// birleştirmesiyle AYNI mantık. Mail Şablonları da aynı sebeple 3. sekme
// olarak eklendi (kullanıcıyla konuşulup kararlaştırıldı).
export function NotificationSettings() {
  const [tab, setTab] = useState<"channels" | "templates" | "escalation" | "oncall">("channels");

  return (
    <div>
      <h1 className="text-lg font-medium mb-1">Bildirimler</h1>
      <p className="text-sm text-text-secondary mb-4">
        Önce bir kanal (email/webhook) tanımla, sonra hangi durumlarda bildirim almak istediğini,
        mail içeriğini ve çözülmeyen alarmların nasıl eskalasyon edeceğini seç.
      </p>

      <div className="flex gap-1 bg-surface-1 rounded-md p-1 border border-border w-fit mb-5">
        <button onClick={() => setTab("channels")} className={`text-xs px-3 py-1.5 rounded ${tab === "channels" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
          Kanallar
        </button>
        <button onClick={() => setTab("templates")} className={`text-xs px-3 py-1.5 rounded ${tab === "templates" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
          Mail Şablonları
        </button>
        <button onClick={() => setTab("escalation")} className={`text-xs px-3 py-1.5 rounded ${tab === "escalation" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
          Eskalasyon Politikaları
        </button>
        <button onClick={() => setTab("oncall")} className={`text-xs px-3 py-1.5 rounded ${tab === "oncall" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
          Nöbet Çizelgeleri
        </button>
      </div>

      {tab === "channels" && (
        <>
          <MediaTypesSection />
          <div className="mt-8" />
          <UserMediaSection title="Bildirim tercihlerim" />
        </>
      )}
      {tab === "templates" && <EmailTemplatesTab />}
      {tab === "escalation" && <EscalationPoliciesTab />}
      {tab === "oncall" && <OnCallSchedulesTab />}
    </div>
  );
}

// GERÇEK EKSİKLİK DÜZELTMESİ (bildirim sistemi tasarımı): önceden bu form
// SADECE type+name topluyordu, config HER ZAMAN {} gönderiliyordu -- e-posta
// kanalı SMTP alanları olmadan asla çalışamıyordu. Artık type'a göre doğru
// alt-form gösteriliyor. Aynı form hem "Kanal ekle" hem "Düzenle" için kullanılıyor.
function MediaTypeConfigForm({
  type, config, onChange
}: {
  type: MediaTypeKind;
  config: MediaTypeConfig;
  onChange: (config: MediaTypeConfig) => void;
}) {
  if (type === "webhook") {
    return (
      <div className="flex flex-col gap-2 w-full">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-secondary">Payload formatı</label>
          <select
            value={config.format || "generic"}
            onChange={(e) => onChange({ ...config, format: e.target.value as MediaTypeConfig["format"] })}
            className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40"
          >
            <option value="generic">Genel (ham JSON)</option>
            <option value="slack">Slack</option>
            <option value="teams">Microsoft Teams</option>
            <option value="pagerduty">PagerDuty</option>
          </select>
        </div>
        {config.format === "pagerduty" && (
          <p className="text-[11px] text-text-muted max-w-md">
            PagerDuty'de "hedef" (kullanıcı tercihlerindeki/"destination") alanına webhook URL'i DEĞİL,
            entegrasyonun <strong>routing key</strong>'i (integration key) girilmeli -- istek her zaman
            PagerDuty Events API v2'ye ({"https://events.pagerduty.com/v2/enqueue"}) gider.
          </p>
        )}
      </div>
    );
  }

  if (type === "sms") {
    return (
      <div className="flex items-end gap-2 flex-wrap bg-surface-1 border border-border rounded-md p-2.5 w-full">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-secondary">HTTP endpoint</label>
          <input value={config.sms_endpoint_url || ""} onChange={(e) => onChange({ ...config, sms_endpoint_url: e.target.value })} required className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-2 w-56" placeholder="https://sms-saglayici.com/api/send" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-secondary">Yöntem</label>
          <select value={config.sms_method || "POST"} onChange={(e) => onChange({ ...config, sms_method: e.target.value as MediaTypeConfig["sms_method"] })} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-2">
            <option value="POST">POST</option>
            <option value="GET">GET</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-secondary">Auth header adı</label>
          <input value={config.sms_auth_header || ""} onChange={(e) => onChange({ ...config, sms_auth_header: e.target.value })} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-2 w-36" placeholder="X-Api-Key" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-secondary">
            Auth token/anahtar {config.has_sms_auth_token && <span className="text-text-muted">(ayarlı, değiştirmek için yaz)</span>}
          </label>
          <input type="password" value={config.sms_auth_token || ""} onChange={(e) => onChange({ ...config, sms_auth_token: e.target.value })} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-2 w-36" placeholder={config.has_sms_auth_token ? "••••••" : ""} />
        </div>
        <div className="flex flex-col gap-1 w-full">
          <label className="text-xs text-text-secondary">
            Gövde şablonu (opsiyonel -- {"{{to}}"} ve {"{{message}}"} değişkenleri)
          </label>
          <input value={config.sms_body_template || ""} onChange={(e) => onChange({ ...config, sms_body_template: e.target.value })} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-2 w-full font-mono" placeholder={'{"to":"{{to}}","message":"{{message}}"}'} />
        </div>
      </div>
    );
  }

  if (type === "webpush") {
    return (
      <p className="text-xs text-text-muted bg-surface-1 border border-border rounded-md p-2.5 w-full">
        Tarayıcı push için ek bir ayar gerekmiyor -- sunucu VAPID anahtarlarıyla otomatik çalışır.
        Her kullanıcı "Bildirim tercihlerim" bölümünden kendi tarayıcısını etkinleştirir.
      </p>
    );
  }

  return (
    <div className="flex items-end gap-2 flex-wrap bg-surface-1 border border-border rounded-md p-2.5 w-full">
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-secondary">SMTP host</label>
        <input value={config.smtp_host || ""} onChange={(e) => onChange({ ...config, smtp_host: e.target.value })} required className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-2 w-40" placeholder="smtp.gmail.com" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-secondary">Port</label>
        <input type="number" value={config.smtp_port ?? 587} onChange={(e) => onChange({ ...config, smtp_port: Number(e.target.value) })} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-2 w-20" />
      </div>
      <label className="flex items-center gap-1.5 text-xs text-text-secondary pb-1.5 cursor-pointer">
        <input type="checkbox" checked={!!config.smtp_secure} onChange={(e) => onChange({ ...config, smtp_secure: e.target.checked })} />
        TLS/SSL
      </label>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-secondary">Kullanıcı</label>
        <input value={config.smtp_user || ""} onChange={(e) => onChange({ ...config, smtp_user: e.target.value })} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-2 w-36" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-secondary">
          Şifre {config.has_smtp_password && <span className="text-text-muted">(ayarlı, değiştirmek için yaz)</span>}
        </label>
        <input type="password" value={config.smtp_pass || ""} onChange={(e) => onChange({ ...config, smtp_pass: e.target.value })} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-2 w-36" placeholder={config.has_smtp_password ? "••••••" : ""} />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-secondary">Gönderen (From)</label>
        <input value={config.from || ""} onChange={(e) => onChange({ ...config, from: e.target.value })} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-2 w-44" placeholder="alerts@sirket.com" />
      </div>
    </div>
  );
}

function TestSendButton({ mediaTypeId, mediaTypeKind, defaultDestination }: { mediaTypeId: string; mediaTypeKind: MediaTypeKind; defaultDestination?: string }) {
  const [open, setOpen] = useState(false);
  const [destination, setDestination] = useState(defaultDestination || "");
  const test = useTestMediaType(mediaTypeId);

  // Web push için hedef, kullanıcının kendi yazacağı bir şey DEĞİL -- bu tarayıcının
  // zaten kayıtlı push aboneliği varsa otomatik alınır (subscription JSON'u).
  const isWebpush = mediaTypeKind === "webpush";
  function openAndFillWebpush() {
    setOpen(true);
    if (!isWebpush || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => { if (sub) setDestination(JSON.stringify(sub)); })
      .catch(() => {});
  }

  if (!open) {
    return (
      <button onClick={openAndFillWebpush} title="Test bildirimi gönder" className="text-text-muted hover:text-text-accent">
        <Send size={13} />
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      {isWebpush ? (
        <span className="text-[11px] text-text-muted px-2 py-1">{destination ? "bu tarayıcı" : "bu tarayıcıda abonelik yok"}</span>
      ) : (
        <input
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="hedef (email/webhook URL)"
          className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 w-40"
        />
      )}
      <button
        onClick={() => test.mutate(destination)}
        disabled={!destination || test.isPending}
        className="text-xs px-2 py-1 rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50"
      >
        Gönder
      </button>
      <button onClick={() => setOpen(false)} className="text-text-muted"><X size={14} /></button>
      {test.isSuccess && <span className="text-[11px] text-[var(--text-success)]">Gönderildi</span>}
      {test.isError && <span className="text-[11px] text-[var(--text-danger)]" title={(test.error as Error).message}>Başarısız</span>}
    </div>
  );
}

function MediaTypesSection() {
  const { data: mediaTypes, isLoading } = useMediaTypes();
  const createMediaType = useCreateMediaType();
  const deleteMediaType = useDeleteMediaType();

  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState<MediaTypeKind>("webhook");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<MediaTypeConfig>({});
  const [editingId, setEditingId] = useState<string | null>(null);

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createMediaType.mutate(
      { type, name, config },
      { onSuccess: () => { setName(""); setConfig({}); setShowForm(false); } }
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium">Kanallar</p>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
          <Plus size={14} />
          Kanal ekle
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-4 mb-3 flex items-end gap-3 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Tip</label>
            <select value={type} onChange={(e) => { setType(e.target.value as MediaTypeKind); setConfig({}); }} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1">
              <option value="webhook">{MEDIA_TYPE_LABEL.webhook}</option>
              <option value="email">{MEDIA_TYPE_LABEL.email}</option>
              <option value="sms">{MEDIA_TYPE_LABEL.sms}</option>
              <option value="webpush">{MEDIA_TYPE_LABEL.webpush}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Kanal adı</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-56" placeholder="Slack Webhook" />
          </div>
          <MediaTypeConfigForm type={type} config={config} onChange={setConfig} />
          <button type="submit" disabled={createMediaType.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white shrink-0">
            Oluştur
          </button>
        </form>
      )}

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        {mediaTypes?.map((mt) => (
          <MediaTypeRow key={mt.id} mediaType={mt} editing={editingId === mt.id} onEdit={() => setEditingId(editingId === mt.id ? null : mt.id)} onDelete={() => deleteMediaType.mutate(mt.id)} />
        ))}
        {mediaTypes?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz kanal tanımlanmadı.</p>}
      </div>
    </div>
  );
}

function MediaTypeRow({ mediaType, editing, onEdit, onDelete }: { mediaType: MediaType; editing: boolean; onEdit: () => void; onDelete: () => void }) {
  const updateMediaType = useUpdateMediaType(mediaType.id);
  const [name, setName] = useState(mediaType.name);
  const [config, setConfig] = useState<MediaTypeConfig>(mediaType.config);

  function handleSave() {
    updateMediaType.mutate({ name, config }, { onSuccess: onEdit });
  }

  return (
    <div className="border-b border-border last:border-0">
      <div className="flex items-center gap-3 px-4 py-2.5">
        {mediaType.type === "email" ? <Mail size={15} className="text-text-secondary" />
          : mediaType.type === "webhook" ? <Webhook size={15} className="text-text-secondary" />
          : mediaType.type === "sms" ? <MessageSquare size={15} className="text-text-secondary" />
          : <BellRing size={15} className="text-text-secondary" />}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{mediaType.name}</p>
          {mediaType.type === "email" && (
            <p className="text-[11px] text-text-muted">
              {mediaType.config.smtp_host || "host ayarlanmadı"} · {mediaType.config.has_smtp_password ? "şifre ayarlı" : "şifre ayarlanmadı"}
            </p>
          )}
          {mediaType.type === "webhook" && (
            <p className="text-[11px] text-text-muted">format: {mediaType.config.format || "generic"}</p>
          )}
          {mediaType.type === "sms" && (
            <p className="text-[11px] text-text-muted">
              {mediaType.config.sms_endpoint_url || "endpoint ayarlanmadı"} · {mediaType.config.has_sms_auth_token ? "token ayarlı" : "token ayarlanmadı"}
            </p>
          )}
        </div>
        <span className="text-xs text-text-muted">{MEDIA_TYPE_LABEL[mediaType.type]}</span>
        <TestSendButton mediaTypeId={mediaType.id} mediaTypeKind={mediaType.type} />
        <button onClick={onEdit} className="text-text-muted hover:text-text-accent">
          <Pencil size={13} />
        </button>
        <button onClick={onDelete} className="text-text-muted hover:text-[var(--text-danger)]">
          <Trash2 size={13} />
        </button>
      </div>
      {editing && (
        <div className="px-4 pb-3 flex items-end gap-3 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Kanal adı</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-56" />
          </div>
          <MediaTypeConfigForm type={mediaType.type} config={config} onChange={setConfig} />
          <button onClick={handleSave} disabled={updateMediaType.isPending} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white shrink-0">
            <Check size={14} />
            Kaydet
          </button>
        </div>
      )}
    </div>
  );
}

// userId verilirse admin başka bir kullanıcının bildirim tercihlerini yönetiyor demektir
// (Kullanıcılar sayfasındaki satır içi panelde kullanılıyor) -- yoksa giriş yapan
// kullanıcının kendi tercihleri (Bildirimler > Kanallar sekmesi).
export function UserMediaSection({ userId, title }: { userId?: string; title: string }) {
  const { data: mediaTypes } = useMediaTypes();
  const { data: groups } = useDeviceGroups();
  const { data: userMedia, isLoading } = useUserMedia(userId);
  const createUserMedia = useCreateUserMedia(userId);
  const deleteUserMedia = useDeleteUserMedia(userId);

  const [showForm, setShowForm] = useState(false);
  const [mediaTypeId, setMediaTypeId] = useState("");
  const [destination, setDestination] = useState("");
  const [deviceGroupId, setDeviceGroupId] = useState("");
  const [minSeverity, setMinSeverity] = useState("warning");
  const [editingId, setEditingId] = useState<string | null>(null);

  const selectedMediaType = mediaTypes?.find((mt) => mt.id === mediaTypeId);
  const isWebpush = selectedMediaType?.type === "webpush";

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createUserMedia.mutate(
      { media_type_id: mediaTypeId, destination, device_group_id: deviceGroupId || null, min_severity: minSeverity },
      { onSuccess: () => { setDestination(""); setDeviceGroupId(""); setShowForm(false); } }
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium">{title}</p>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
          <Plus size={14} />
          Tercih ekle
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-4 mb-3 flex items-end gap-3 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Kanal</label>
            <select value={mediaTypeId} onChange={(e) => setMediaTypeId(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40">
              <option value="">Seçin</option>
              {mediaTypes?.map((mt) => <option key={mt.id} value={mt.id}>{mt.name}</option>)}
            </select>
          </div>
          {isWebpush ? (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">Bu tarayıcı</label>
              <WebPushSubscribeButton onSubscribed={setDestination} subscribed={!!destination} />
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">
                Hedef {selectedMediaType?.type === "sms" ? "(telefon numarası)" : selectedMediaType?.config.format === "pagerduty" ? "(routing key)" : "(email / webhook URL)"}
              </label>
              <input value={destination} onChange={(e) => setDestination(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-64" placeholder="https://... veya email@... veya +90..." />
            </div>
          )}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Host grubu (opsiyonel)</label>
            <select value={deviceGroupId} onChange={(e) => setDeviceGroupId(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40">
              <option value="">Tüm cihazlar</option>
              {groups?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Min. önem</label>
            <select value={minSeverity} onChange={(e) => setMinSeverity(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1">
              {SEVERITY_LEVELS.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
            </select>
          </div>
          <button type="submit" disabled={createUserMedia.isPending || (isWebpush && !destination)} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50">
            Ekle
          </button>
        </form>
      )}

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        {userMedia?.map((um) => (
          <UserMediaRow
            key={um.id}
            userMedia={um}
            groups={groups}
            editing={editingId === um.id}
            onEdit={() => setEditingId(editingId === um.id ? null : um.id)}
            onDelete={() => deleteUserMedia.mutate(um.id)}
            userId={userId}
          />
        ))}
        {userMedia?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz bildirim tercihi tanımlanmadı.</p>}
      </div>
    </div>
  );
}

function UserMediaRow({
  userMedia, groups, editing, onEdit, onDelete, userId
}: {
  userMedia: UserMedia;
  groups: { id: string; name: string }[] | undefined;
  editing: boolean;
  onEdit: () => void;
  onDelete: () => void;
  userId?: string;
}) {
  const updateUserMedia = useUpdateUserMedia(userMedia.id, userId);
  const [destination, setDestination] = useState(userMedia.destination);
  const [deviceGroupId, setDeviceGroupId] = useState(userMedia.device_group_id ?? "");
  const [minSeverity, setMinSeverity] = useState(userMedia.min_severity);

  function handleSave() {
    updateUserMedia.mutate(
      { destination, device_group_id: deviceGroupId || null, min_severity: minSeverity },
      { onSuccess: onEdit }
    );
  }

  return (
    <div className="border-b border-border last:border-0">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{userMedia.media_type === "webpush" ? "Bu tarayıcı (push aboneliği)" : userMedia.destination}</p>
          <p className="text-xs text-text-muted">
            {userMedia.media_type_name} · {userMedia.device_group_name ?? "Tüm cihazlar"} · min: {SEVERITY_LABEL[userMedia.min_severity] ?? userMedia.min_severity}
          </p>
        </div>
        <button onClick={onEdit} className="text-text-muted hover:text-text-accent">
          <Pencil size={13} />
        </button>
        <button onClick={onDelete} className="text-text-muted hover:text-[var(--text-danger)]">
          <Trash2 size={13} />
        </button>
      </div>
      {editing && (
        <div className="px-4 pb-3 flex items-end gap-3 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Hedef (email / webhook URL)</label>
            <input value={destination} onChange={(e) => setDestination(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-64" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Host grubu (opsiyonel)</label>
            <select value={deviceGroupId} onChange={(e) => setDeviceGroupId(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40">
              <option value="">Tüm cihazlar</option>
              {groups?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Min. önem</label>
            <select value={minSeverity} onChange={(e) => setMinSeverity(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1">
              {SEVERITY_LEVELS.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
            </select>
          </div>
          <button onClick={handleSave} disabled={updateUserMedia.isPending} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white shrink-0">
            <Check size={14} />
            Kaydet
          </button>
        </div>
      )}
    </div>
  );
}

const TEMPLATE_TYPE_LABEL: Record<EmailTemplateType, string> = {
  new_alert: "Yeni alarm",
  resolved_alert: "Çözüldü",
  escalation: "Eskalasyon"
};

const TEMPLATE_TYPE_ORDER: EmailTemplateType[] = ["new_alert", "resolved_alert", "escalation"];

// Önizlemede kullanılan örnek veriler -- gerçek bir alarm beklemeden şablonun
// nasıl görüneceğini göstermek için. Backend'deki (notify.ts) değişken
// isimleriyle BİREBİR aynı olmalı.
const PREVIEW_SAMPLE_VARS: Record<string, string> = {
  cihaz_adi: "Core-Switch-01",
  severity: "critical",
  severity_etiketi: "Kritik",
  mesaj: "CPU kullanımı %95'i aştı",
  tetiklenme_zamani: "23.07.2026 14:32",
  cozulme_zamani: "23.07.2026 15:10",
  adim_no: "2",
  alarm_linki: "https://dashboard.ornek.com/alerts/123"
};

function renderPreview(text: string): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => PREVIEW_SAMPLE_VARS[key] ?? "");
}

const TEMPLATE_VARIABLES = [
  "{{cihaz_adi}}", "{{severity}}", "{{severity_etiketi}}", "{{mesaj}}",
  "{{tetiklenme_zamani}}", "{{cozulme_zamani}}", "{{adim_no}}", "{{alarm_linki}}"
];

function EmailTemplatesTab() {
  const { data: templates, isLoading } = useEmailTemplates();

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-text-muted -mt-2">
        Kullanılabilir değişkenler: {TEMPLATE_VARIABLES.map((v) => (
          <code key={v} className="mx-0.5 px-1 py-0.5 rounded bg-surface-1 border border-border text-[10px]">{v}</code>
        ))}
        {" "}-- <code>{"{{cozulme_zamani}}"}</code> sadece "Çözüldü", <code>{"{{adim_no}}"}</code> sadece "Eskalasyon" şablonunda dolu gelir.
      </p>
      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}
      {TEMPLATE_TYPE_ORDER.map((type) => {
        const template = templates?.find((t) => t.template_type === type);
        return template ? <EmailTemplateCard key={template.id} template={template} /> : null;
      })}
    </div>
  );
}

function EmailTemplateCard({ template }: { template: EmailTemplate }) {
  const { data: mediaTypes } = useMediaTypes();
  const emailChannels = mediaTypes?.filter((mt) => mt.type === "email") ?? [];
  const updateTemplate = useUpdateEmailTemplate(template.id);
  const resetTemplate = useResetEmailTemplate(template.id);
  const testTemplate = useTestEmailTemplate(template.id);

  const [subject, setSubject] = useState(template.subject);
  const [bodyHtml, setBodyHtml] = useState(template.body_html);
  const [showPreview, setShowPreview] = useState(true);
  const [showTest, setShowTest] = useState(false);
  const [testMediaTypeId, setTestMediaTypeId] = useState("");
  const [testDestination, setTestDestination] = useState("");

  const dirty = subject !== template.subject || bodyHtml !== template.body_html;

  function handleSave() {
    updateTemplate.mutate({ subject, body_html: bodyHtml });
  }

  function handleReset() {
    if (!confirm("Bu şablonu varsayılan içeriğe döndürmek istediğine emin misin? Yaptığın değişiklikler kaybolur.")) return;
    resetTemplate.mutate(undefined, {
      onSuccess: (data) => { setSubject(data.subject); setBodyHtml(data.body_html); }
    });
  }

  return (
    <div className="border border-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium">{TEMPLATE_TYPE_LABEL[template.template_type]}</p>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowTest((v) => !v)} title="Test gönder" className="text-text-muted hover:text-text-accent">
            <Send size={14} />
          </button>
          <button onClick={handleReset} disabled={resetTemplate.isPending} title="Varsayılana döndür" className="text-text-muted hover:text-[var(--text-danger)]">
            <RotateCcw size={14} />
          </button>
        </div>
      </div>

      {showTest && (
        <div className="flex items-end gap-2 mb-3 bg-surface-1 border border-border rounded-md p-2.5 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Kanal</label>
            <select value={testMediaTypeId} onChange={(e) => setTestMediaTypeId(e.target.value)} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-2 w-40">
              <option value="">Seçin</option>
              {emailChannels.map((mt) => <option key={mt.id} value={mt.id}>{mt.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Hedef email</label>
            <input value={testDestination} onChange={(e) => setTestDestination(e.target.value)} placeholder="ornek@sirket.com" className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-2 w-52" />
          </div>
          <button
            onClick={() => testTemplate.mutate({ mediaTypeId: testMediaTypeId, destination: testDestination })}
            disabled={!testMediaTypeId || !testDestination || testTemplate.isPending}
            className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50"
          >
            Gönder
          </button>
          {testTemplate.isSuccess && <span className="text-[11px] text-[var(--text-success)]">Gönderildi</span>}
          {testTemplate.isError && <span className="text-[11px] text-[var(--text-danger)]" title={(testTemplate.error as Error).message}>Başarısız</span>}
          {emailChannels.length === 0 && <p className="text-[11px] text-text-muted w-full">Test göndermek için önce "Kanallar" sekmesinde bir email kanalı oluşturun.</p>}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="flex flex-col gap-2">
          <div>
            <label className="text-xs text-text-secondary mb-1 block">Konu</label>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
          </div>
          <div>
            <label className="text-xs text-text-secondary mb-1 block">HTML gövde</label>
            <textarea
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
              rows={12}
              className="w-full px-2.5 py-1.5 text-xs font-mono rounded-md border border-border bg-surface-1 resize-y"
              spellCheck={false}
            />
          </div>
          <button
            onClick={handleSave}
            disabled={!dirty || updateTemplate.isPending}
            className="self-start flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50"
          >
            <Check size={14} />
            Kaydet
          </button>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-text-secondary">Önizleme (örnek verilerle)</label>
            <button onClick={() => setShowPreview((v) => !v)} className="text-[11px] text-text-accent">
              {showPreview ? "gizle" : "göster"}
            </button>
          </div>
          {showPreview && (
            <div className="border border-border rounded-md overflow-hidden bg-white">
              <div className="px-2.5 py-1.5 border-b border-border bg-surface-1 text-xs text-text-secondary truncate">
                {renderPreview(subject)}
              </div>
              <iframe
                title="Mail önizleme"
                srcDoc={renderPreview(bodyHtml)}
                sandbox=""
                className="w-full"
                style={{ height: 340, border: "none" }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
