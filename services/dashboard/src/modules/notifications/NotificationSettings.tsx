import { useState } from "react";
import { Plus, Trash2, Mail, Webhook } from "lucide-react";
import {
  useMediaTypes, useCreateMediaType, useDeleteMediaType,
  useUserMedia, useCreateUserMedia, useDeleteUserMedia
} from "./useNotifications";
import { useDeviceGroups } from "../deviceGroups/useDeviceGroups";
import { SEVERITY_LEVELS, SEVERITY_LABEL } from "../shared/severity";

export function NotificationSettings() {
  return (
    <div>
      <h1 className="text-lg font-medium mb-1">Bildirim kanalları</h1>
      <p className="text-sm text-text-secondary mb-5">
        Önce bir kanal (email/webhook) tanımla, sonra hangi durumlarda bildirim almak istediğini seç.
      </p>

      <MediaTypesSection />
      <div className="mt-8" />
      <UserMediaSection />
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

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createMediaType.mutate(
      { type, name, config: {} },
      { onSuccess: () => { setName(""); setShowForm(false); } }
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
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-4 mb-3 flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Tip</label>
            <select value={type} onChange={(e) => setType(e.target.value as "email" | "webhook")} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1">
              <option value="webhook">Webhook</option>
              <option value="email">E-posta (SMTP)</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Kanal adı</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-56" placeholder="Slack Webhook" />
          </div>
          <button type="submit" disabled={createMediaType.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
            Oluştur
          </button>
        </form>
      )}

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        {mediaTypes?.map((mt) => (
          <div key={mt.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0">
            {mt.type === "email" ? <Mail size={15} className="text-text-secondary" /> : <Webhook size={15} className="text-text-secondary" />}
            <p className="text-sm font-medium flex-1">{mt.name}</p>
            <span className="text-xs text-text-muted">{mt.type}</span>
            <button onClick={() => deleteMediaType.mutate(mt.id)} className="text-text-muted hover:text-[var(--text-danger)]">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {mediaTypes?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz kanal tanımlanmadı.</p>}
      </div>
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
