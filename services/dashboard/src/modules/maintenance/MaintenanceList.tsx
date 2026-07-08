import { useState } from "react";
import { Plus, Trash2, Clock } from "lucide-react";
import { useMaintenanceWindows, useCreateMaintenanceWindow, useDeleteMaintenanceWindow } from "./useMaintenance";
import { useDevices } from "../devices/useDevices";
import { useDeviceGroups } from "../deviceGroups/useDeviceGroups";

export function MaintenanceList() {
  const { data: windows, isLoading } = useMaintenanceWindows();
  const { data: devices } = useDevices({ limit: 200 });
  const { data: groups } = useDeviceGroups();
  const createWindow = useCreateMaintenanceWindow();
  const deleteWindow = useDeleteMaintenanceWindow();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createWindow.mutate(
      {
        name,
        starts_at: new Date(startsAt).toISOString(),
        ends_at: new Date(endsAt).toISOString(),
        device_ids: selectedDeviceId ? [selectedDeviceId] : undefined,
        device_group_ids: selectedGroupId ? [selectedGroupId] : undefined
      },
      { onSuccess: () => { setName(""); setStartsAt(""); setEndsAt(""); setSelectedDeviceId(""); setSelectedGroupId(""); setShowForm(false); } }
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium">Bakım pencereleri</h1>
          <p className="text-sm text-text-secondary">Bu süre boyunca seçili cihaz/gruplardan alarm üretilmez</p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
          <Plus size={15} />
          Bakım penceresi oluştur
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-4 mb-4 flex items-end gap-3 flex-wrap">
          <div>
            <label className="text-xs text-text-secondary mb-1 block">Ad</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-48" placeholder="Gece bakımı" />
          </div>
          <div>
            <label className="text-xs text-text-secondary mb-1 block">Başlangıç</label>
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
          </div>
          <div>
            <label className="text-xs text-text-secondary mb-1 block">Bitiş</label>
            <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
          </div>
          <div>
            <label className="text-xs text-text-secondary mb-1 block">Cihaz (opsiyonel)</label>
            <select value={selectedDeviceId} onChange={(e) => setSelectedDeviceId(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40">
              <option value="">Seçilmedi</option>
              {devices?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-text-secondary mb-1 block">Host grubu (opsiyonel)</label>
            <select value={selectedGroupId} onChange={(e) => setSelectedGroupId(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40">
              <option value="">Seçilmedi</option>
              {groups?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <button type="submit" disabled={createWindow.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
            Oluştur
          </button>
        </form>
      )}

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        {windows?.map((w) => (
          <div key={w.id} className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-0">
            <Clock size={16} className={w.is_active ? "text-[var(--text-warning)]" : "text-text-secondary"} />
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">{w.name}</p>
                {w.is_active && <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--bg-warning)] text-[var(--text-warning)] font-medium">aktif</span>}
              </div>
              <p className="text-xs text-text-muted">
                {new Date(w.starts_at).toLocaleString("tr-TR")} → {new Date(w.ends_at).toLocaleString("tr-TR")} · {w.device_count} cihaz, {w.group_count} grup
              </p>
            </div>
            <button onClick={() => deleteWindow.mutate(w.id)} className="text-text-muted hover:text-[var(--text-danger)]"><Trash2 size={14} /></button>
          </div>
        ))}
        {windows?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz bakım penceresi tanımlanmadı.</p>}
      </div>
    </div>
  );
}
