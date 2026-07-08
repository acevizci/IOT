import { useState } from "react";
import { Link } from "react-router-dom";
import { Search, Plus, Pencil, Trash2, Radar } from "lucide-react";
import { useDevices, useDeviceFacets, useDeviceTags, useDeleteDevice, useBulkDeleteDevices } from "./useDevices";
import { CreateDeviceModal } from "./CreateDeviceModal";
import { SubnetScanModal } from "../discovery/SubnetScanModal";
import { EditDeviceModal } from "./EditDeviceModal";
import type { Device } from "../../api/devices";

const STATUS_LABEL: Record<string, string> = { active: "sağlıklı", degraded: "uyarı", down: "erişilemiyor" };
const STATUS_STYLES: Record<string, string> = {
  active: "bg-[var(--bg-success)] text-[var(--text-success)]",
  degraded: "bg-[var(--bg-warning)] text-[var(--text-warning)]",
  down: "bg-[var(--bg-danger)] text-[var(--text-danger)]"
};

export function DeviceList() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [deviceType, setDeviceType] = useState("");
  const [tag, setTag] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);
  const [editingDevice, setEditingDevice] = useState<Device | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data: facets } = useDeviceFacets();
  const { data: tags } = useDeviceTags();
  const { data: devices, isLoading, error } = useDevices({
    search: search || undefined,
    status: status || undefined,
    device_type: deviceType || undefined,
    tag: tag || undefined,
    limit: 50
  });

  const deleteDevice = useDeleteDevice();
  const bulkDelete = useBulkDeleteDevices();

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (!devices) return;
    setSelectedIds((prev) => (prev.size === devices.length ? new Set() : new Set(devices.map((d) => d.id))));
  }

  function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    if (!confirm(`${selectedIds.size} cihazı silmek istediğine emin misin?`)) return;
    bulkDelete.mutate(Array.from(selectedIds), { onSuccess: () => setSelectedIds(new Set()) });
  }

  function handleDelete(id: string, name: string) {
    if (!confirm(`"${name}" cihazını silmek istediğine emin misin?`)) return;
    deleteDevice.mutate(id);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium">Cihazlar</h1>
          <p className="text-sm text-text-secondary">{devices?.length ?? 0} cihaz</p>
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <button onClick={handleBulkDelete} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-[var(--text-danger)] text-[var(--text-danger)]">
              <Trash2 size={15} />
              {selectedIds.size} cihazı sil
            </button>
          )}
          <button onClick={() => setShowScanModal(true)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
            <Radar size={15} />
            Ağ taraması
          </button>
          <button onClick={() => setShowCreateModal(true)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
            <Plus size={15} />
            Cihaz ekle
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-border max-w-xs w-full">
          <Search size={15} className="text-text-muted shrink-0" />
          <input type="text" placeholder="İsim veya IP ara..." value={search} onChange={(e) => setSearch(e.target.value)} className="text-sm bg-transparent outline-none w-full" />
        </div>

        <select value={status} onChange={(e) => setStatus(e.target.value)} className="text-sm px-3 py-2 rounded-md border border-border bg-surface-1">
          <option value="">Durum: tümü</option>
          {facets?.statuses.map((s) => <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>)}
        </select>

        <select value={deviceType} onChange={(e) => setDeviceType(e.target.value)} className="text-sm px-3 py-2 rounded-md border border-border bg-surface-1">
          <option value="">Tip: tümü</option>
          {facets?.device_types.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>

        {tags && tags.length > 0 && (
          <select value={tag} onChange={(e) => setTag(e.target.value)} className="text-sm px-3 py-2 rounded-md border border-border bg-surface-1">
            <option value="">Etiket: tümü</option>
            {tags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
      </div>

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}
      {error && <p className="text-sm text-[var(--text-danger)]">Hata: {(error as Error).message}</p>}

      {devices && (
        <div className="border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-1 text-text-secondary text-left">
                <th className="p-3 w-8">
                  <input type="checkbox" checked={devices.length > 0 && selectedIds.size === devices.length} onChange={toggleSelectAll} />
                </th>
                <th className="p-3 font-medium w-6"></th>
                <th className="p-3 font-medium">İsim</th>
                <th className="p-3 font-medium">IP adresi</th>
                <th className="p-3 font-medium">Tip</th>
                <th className="p-3 font-medium">Etiketler</th>
                <th className="p-3 font-medium">Lokasyon</th>
                <th className="p-3 font-medium">Durum</th>
                <th className="p-3 font-medium w-16"></th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id} className="border-t border-border hover:bg-surface-1">
                  <td className="p-3">
                    <input type="checkbox" checked={selectedIds.has(d.id)} onChange={() => toggleSelect(d.id)} />
                  </td>
                  <td className="p-3">
                    <span className={`block w-1.5 h-1.5 rounded-full ${d.status === "active" ? "bg-[var(--text-success)]" : "bg-[var(--text-warning)]"}`} />
                  </td>
                  <td className="p-0">
                    <Link to={`/devices/${d.id}`} className="block p-3 font-medium">{d.name}</Link>
                  </td>
                  <td className="p-3 text-text-secondary font-mono text-xs">{d.ip_address}</td>
                  <td className="p-3 text-text-secondary">{d.device_type}</td>
                  <td className="p-3">
                    <div className="flex gap-1 flex-wrap">
                      {(d.attributes?.tags ?? []).map((t) => (
                        <span key={t} className="text-[11px] px-1.5 py-0.5 rounded bg-surface-0 text-text-secondary border border-border">{t}</span>
                      ))}
                    </div>
                  </td>
                  <td className="p-3 text-text-secondary">{d.location ?? "-"}</td>
                  <td className="p-3">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLES[d.status] ?? "bg-surface-1 text-text-secondary"}`}>
                      {STATUS_LABEL[d.status] ?? d.status}
                    </span>
                  </td>
                  <td className="p-3">
                    <div className="flex gap-2">
                      <button onClick={() => setEditingDevice(d)} className="text-text-muted hover:text-[var(--text-accent)]"><Pencil size={14} /></button>
                      <button onClick={() => handleDelete(d.id, d.name)} className="text-text-muted hover:text-[var(--text-danger)]"><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {devices.length === 0 && <p className="text-sm text-text-muted p-4">Cihaz bulunamadı.</p>}
        </div>
      )}

      {showCreateModal && <CreateDeviceModal onClose={() => setShowCreateModal(false)} />}
      {editingDevice && <EditDeviceModal device={editingDevice} onClose={() => setEditingDevice(null)} />}
      {showScanModal && <SubnetScanModal onClose={() => setShowScanModal(false)} />}
    </div>
  );
}
