import { useState } from "react";
import { Plus, Trash2, CalendarClock, User, Clock } from "lucide-react";
import {
  useOnCallSchedules, useCreateOnCallSchedule, useDeleteOnCallSchedule, useCurrentOnCall,
  useOnCallLayers, useCreateOnCallLayer, useDeleteOnCallLayer,
  useOnCallOverrides, useCreateOnCallOverride, useDeleteOnCallOverride
} from "./useOnCallSchedules";
import { useUsers } from "../users/useUsers";

// Postgres EXTRACT(DOW): 0=Pazar ... 6=Cumartesi (core'daki resolveOnCallUserId ile AYNI).
const DAY_LABELS = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];

function formatTime(t: string): string {
  return t.slice(0, 5);
}

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Nöbet çizelgesi (bildirim sistemi son parçası, kullanıcıyla konuşulup kararlaştırıldı):
// takvim bazlı, saat/gün bazlı katmanlar + öncelik bazlı çakışma çözümü + manuel geçersiz
// kılmalar. Eskalasyon Politikaları'yla AYNI iki-panelli desen (soldan çizelge seç, sağda
// detay) -- bir adım artık sabit bir kişi yerine bu çizelgelerden birine hedeflenebilir.
export function OnCallSchedulesTab() {
  const { data: schedules, isLoading } = useOnCallSchedules();
  const createSchedule = useCreateOnCallSchedule();
  const deleteSchedule = useDeleteOnCallSchedule();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createSchedule.mutate(
      { name, description: description || undefined },
      { onSuccess: (created) => { setName(""); setDescription(""); setShowForm(false); setSelectedId(created.id); } }
    );
  }

  return (
    <div className="grid grid-cols-[1fr_1.6fr] gap-4">
      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-medium">Çizelgeler</p>
          <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
            <Plus size={14} />
            Çizelge ekle
          </button>
        </div>

        {showForm && (
          <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-3 mb-3 flex flex-col gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Çizelge adı (örn. Birincil Nöbet)" className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Açıklama (opsiyonel)" className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
            <button type="submit" disabled={createSchedule.isPending} className="self-start px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
              Oluştur
            </button>
          </form>
        )}

        {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

        <div className="border border-border rounded-xl overflow-hidden">
          {schedules?.map((s) => (
            <div
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              className={`flex items-center gap-2 px-4 py-2.5 border-b border-border last:border-0 cursor-pointer ${selectedId === s.id ? "bg-[var(--bg-accent)]" : "hover:bg-surface-1"}`}
            >
              <CalendarClock size={14} className="text-[var(--text-accent)] shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{s.name}</p>
                <p className="text-[11px] text-text-muted">{s.layer_count} katman{s.description ? ` · ${s.description}` : ""}</p>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!confirm(`"${s.name}" çizelgesini silmek istediğine emin misin?`)) return;
                  deleteSchedule.mutate(s.id, {
                    onSuccess: () => { if (selectedId === s.id) setSelectedId(null); },
                    // Bu çizelge hâlâ bir eskalasyon adımının hedefiyse core 409 döner
                    // (adımın sessizce "herkese bildir"e dönüşmesini önlemek için).
                    onError: (err) => alert((err as Error).message)
                  });
                }}
                className="text-text-muted hover:text-[var(--text-danger)] shrink-0"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {schedules?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz çizelge tanımlanmadı.</p>}
        </div>
      </div>

      <div>
        {selectedId ? (
          <ScheduleDetail scheduleId={selectedId} />
        ) : (
          <p className="text-sm text-text-muted mt-8 text-center">Katmanlarını/geçersiz kılmalarını görmek için soldan bir çizelge seç.</p>
        )}
      </div>
    </div>
  );
}

function ScheduleDetail({ scheduleId }: { scheduleId: string }) {
  const { data: current } = useCurrentOnCall(scheduleId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 bg-surface-1 border border-border rounded-xl px-4 py-3">
        <User size={16} className="text-[var(--text-accent)]" />
        <span className="text-sm">
          Şu an nöbetçi: <span className="font-medium">{current?.email ?? (current === undefined ? "..." : "kimse yok")}</span>
        </span>
      </div>
      <LayersSection scheduleId={scheduleId} />
      <OverridesSection scheduleId={scheduleId} />
    </div>
  );
}

function LayersSection({ scheduleId }: { scheduleId: string }) {
  const { data: layers, isLoading } = useOnCallLayers(scheduleId);
  const { data: users } = useUsers();
  const createLayer = useCreateOnCallLayer(scheduleId);
  const deleteLayer = useDeleteOnCallLayer(scheduleId);

  const [showForm, setShowForm] = useState(false);
  const [userId, setUserId] = useState("");
  const [dayOfWeek, setDayOfWeek] = useState<string>("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("18:00");
  const [priority, setPriority] = useState(0);

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createLayer.mutate(
      { user_id: userId, day_of_week: dayOfWeek === "" ? null : Number(dayOfWeek), start_time: startTime, end_time: endTime, priority },
      { onSuccess: () => setShowForm(false) }
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-sm font-medium">Katmanlar</p>
          <p className="text-[11px] text-text-muted">Haftalık tekrar eden pencereler -- çakışmada YÜKSEK öncelik kazanır.</p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
          <Plus size={14} />
          Katman ekle
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-3 mb-3 flex items-end gap-2 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Kişi</label>
            <select value={userId} onChange={(e) => setUserId(e.target.value)} required className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40">
              <option value="">Seçin</option>
              {users?.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Gün</label>
            <select value={dayOfWeek} onChange={(e) => setDayOfWeek(e.target.value)} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-32">
              <option value="">Her gün</option>
              {DAY_LABELS.map((label, i) => <option key={i} value={i}>{label}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Başlangıç</label>
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary" title="Başlangıçtan küçükse gece yarısını aşan vardiya sayılır (örn. 22:00-06:00)">Bitiş</label>
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary" title="Çakışan katmanlarda yüksek olan kazanır">Öncelik</label>
            <input type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-16" />
          </div>
          <button type="submit" disabled={createLayer.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
            Ekle
          </button>
        </form>
      )}

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        {layers?.map((l) => (
          <div key={l.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0">
            <Clock size={13} className="text-text-muted shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{l.user_email}</p>
              <p className="text-[11px] text-text-muted">
                {l.day_of_week === null ? "her gün" : DAY_LABELS[l.day_of_week]} · {formatTime(l.start_time)}-{formatTime(l.end_time)} · öncelik: {l.priority}
              </p>
            </div>
            <button onClick={() => deleteLayer.mutate(l.id)} className="text-text-muted hover:text-[var(--text-danger)] shrink-0">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {layers?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz katman tanımlanmadı -- çizelge boşken kimse nöbetçi olmaz.</p>}
      </div>
    </div>
  );
}

function OverridesSection({ scheduleId }: { scheduleId: string }) {
  const { data: overrides, isLoading } = useOnCallOverrides(scheduleId);
  const { data: users } = useUsers();
  const createOverride = useCreateOnCallOverride(scheduleId);
  const deleteOverride = useDeleteOnCallOverride(scheduleId);

  const [showForm, setShowForm] = useState(false);
  const [userId, setUserId] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createOverride.mutate(
      { user_id: userId, starts_at: new Date(startsAt).toISOString(), ends_at: new Date(endsAt).toISOString() },
      { onSuccess: () => { setShowForm(false); setStartsAt(""); setEndsAt(""); } }
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-sm font-medium">Geçersiz kılmalar</p>
          <p className="text-[11px] text-text-muted">Tatil/nöbet değişimi -- aktif olduğu sürece TÜM katmanları ezer.</p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
          <Plus size={14} />
          Geçersiz kılma ekle
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-3 mb-3 flex items-end gap-2 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Kişi</label>
            <select value={userId} onChange={(e) => setUserId(e.target.value)} required className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40">
              <option value="">Seçin</option>
              {users?.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Başlangıç</label>
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Bitiş</label>
            <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
          </div>
          <button type="submit" disabled={createOverride.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
            Ekle
          </button>
        </form>
      )}

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        {overrides?.map((o) => (
          <div key={o.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{o.user_email}</p>
              <p className="text-[11px] text-text-muted">{toLocalInputValue(o.starts_at).replace("T", " ")} → {toLocalInputValue(o.ends_at).replace("T", " ")}</p>
            </div>
            <button onClick={() => deleteOverride.mutate(o.id)} className="text-text-muted hover:text-[var(--text-danger)] shrink-0">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {overrides?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz geçersiz kılma tanımlanmadı.</p>}
      </div>
    </div>
  );
}
