import { useState } from "react";
import { Plus, Trash2, Mail, Webhook, Pencil, Send, Check, X } from "lucide-react";
import {
  useMediaTypes, useCreateMediaType, useUpdateMediaType, useDeleteMediaType, useTestMediaType,
  useUserMedia, useCreateUserMedia, useDeleteUserMedia
} from "./useNotifications";
import { useDeviceGroups } from "../deviceGroups/useDeviceGroups";
import { SEVERITY_LEVELS, SEVERITY_LABEL } from "../shared/severity";
import type { MediaType, MediaTypeConfig } from "../../api/notifications";
import { EscalationPoliciesTab } from "../escalationPolicies/EscalationPoliciesTab";

// Kullanıcı kararı: Kanallar ve Eskalasyon Politikaları ayrı üst-seviye
// sayfalar OLMASIN -- ikisi de aynı "bildirim sistemi"nin parçası (bir
// politika adımı bir kanalı referans eder), DeviceDetail'in Kurallar/Makrolar
// birleştirmesiyle AYNI mantık.
export function NotificationSettings() {
  const [tab, setTab] = useState<"channels" | "escalation">("channels");

  return (
    <div>
      <h1 className="text-lg font-medium mb-1">Bildirimler</h1>
      <p className="text-sm text-text-secondary mb-4">
        Önce bir kanal (email/webhook) tanımla, sonra hangi durumlarda bildirim almak istediğini ve
        çözülmeyen alarmların nasıl eskalasyon edeceğini seç.
      </p>

      <div className="flex gap-1 bg-surface-1 rounded-md p-1 border border-border w-fit mb-5">
        <button onClick={() => setTab("channels")} className={`text-xs px-3 py-1.5 rounded ${tab === "channels" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
          Kanallar
        </button>
        <button onClick={() => setTab("escalation")} className={`text-xs px-3 py-1.5 rounded ${tab === "escalation" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
          Eskalasyon Politikaları
        </button>
      </div>

      {tab === "channels" ? (
        <>
          <MediaTypesSection />
          <div className="mt-8" />
          <UserMediaSection />
        </>
      ) : (
        <EscalationPoliciesTab />
      )}
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
  type: "email" | "webhook";
  config: MediaTypeConfig;
  onChange: (config: MediaTypeConfig) => void;
}) {
  if (type === "webhook") {
    return (
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
        </select>
      </div>
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

function TestSendButton({ mediaTypeId, defaultDestination }: { mediaTypeId: string; defaultDestination?: string }) {
  const [open, setOpen] = useState(false);
  const [destination, setDestination] = useState(defaultDestination || "");
  const test = useTestMediaType(mediaTypeId);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} title="Test bildirimi gönder" className="text-text-muted hover:text-text-accent">
        <Send size={13} />
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <input
        value={destination}
        onChange={(e) => setDestination(e.target.value)}
        placeholder="hedef (email/webhook URL)"
        className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 w-40"
      />
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
  const [type, setType] = useState<"email" | "webhook">("webhook");
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
            <select value={type} onChange={(e) => { setType(e.target.value as "email" | "webhook"); setConfig({}); }} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1">
              <option value="webhook">Webhook</option>
              <option value="email">E-posta (SMTP)</option>
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
        {mediaType.type === "email" ? <Mail size={15} className="text-text-secondary" /> : <Webhook size={15} className="text-text-secondary" />}
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
        </div>
        <span className="text-xs text-text-muted">{mediaType.type}</span>
        <TestSendButton mediaTypeId={mediaType.id} />
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

function UserMediaSection() {
  const { data: mediaTypes } = useMediaTypes();
  const { data: groups } = useDeviceGroups();
  const { data: userMedia, isLoading } = useUserMedia();
  const createUserMedia = useCreateUserMedia();
  const deleteUserMedia = useDeleteUserMedia();

  const [showForm, setShowForm] = useState(false);
  const [mediaTypeId, setMediaTypeId] = useState("");
  const [destination, setDestination] = useState("");
  const [deviceGroupId, setDeviceGroupId] = useState("");
  const [minSeverity, setMinSeverity] = useState("warning");

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
        <p className="text-sm font-medium">Bildirim tercihlerim</p>
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
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Hedef (email / webhook URL)</label>
            <input value={destination} onChange={(e) => setDestination(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-64" placeholder="https://... veya email@..." />
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
          <button type="submit" disabled={createUserMedia.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
            Ekle
          </button>
        </form>
      )}

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        {userMedia?.map((um) => (
          <div key={um.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{um.destination}</p>
              <p className="text-xs text-text-muted">
                {um.media_type_name} · {um.device_group_name ?? "Tüm cihazlar"} · min: {SEVERITY_LABEL[um.min_severity] ?? um.min_severity}
              </p>
            </div>
            <button onClick={() => deleteUserMedia.mutate(um.id)} className="text-text-muted hover:text-[var(--text-danger)]">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {userMedia?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz bildirim tercihi tanımlanmadı.</p>}
      </div>
    </div>
  );
}
