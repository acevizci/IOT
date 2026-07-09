import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Search, Plus, Pencil, Trash2, Radar, ChevronLeft, ChevronRight } from "lucide-react";
import { useDevices, useDeviceFacets, useDeviceTags, useDeleteDevice, useBulkDeleteDevices, useBulkAssignGroup, useBulkAssignTemplate } from "./useDevices";
import { useDeviceGroups } from "../deviceGroups/useDeviceGroups";
import { useAlertTemplates } from "../templates/useAlertTemplates";
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

const PAGE_SIZE = 50;

export function DeviceList() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [deviceType, setDeviceType] = useState("");
  const [tag, setTag] = useState("");
  const [page, setPage] = useState(1);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);
  const [editingDevice, setEditingDevice] = useState<Device | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data: facets } = useDeviceFacets();
  const { data: tags } = useDeviceTags();
  const { data, isLoading, error } = useDevices({
    search: search || undefined,
    status: status || undefined,
    device_type: deviceType || undefined,
    tag: tag || undefined,
    limit: PAGE_SIZE,
    page
  });
  const devices = data?.items;
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  // Filtre değişince görünen sonuç kümesi değişir; sayfa 1'e dönmezsek
  // "3. sayfadasın ama artık sadece 1 sayfa var" gibi bir tutarsızlık oluşur.
  useEffect(() => {
    setPage(1);
  }, [search, status, deviceType, tag]);

  const deleteDevice = useDeleteDevice();
  const bulkDelete = useBulkDeleteDevices();
  const bulkAssignGroup = useBulkAssignGroup();
  const bulkAssignTemplate = useBulkAssignTemplate();
  const { data: groups } = useDeviceGroups();
  const { data: templates } = useAlertTemplates();
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [pickedGroupId, setPickedGroupId] = useState("");
  const [pickedTemplateId, setPickedTemplateId] = useState("");
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);

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

  function handleBulkAssignGroup() {
    if (!pickedGroupId || selectedIds.size === 0) return;
    bulkAssignGroup.mutate(
      { deviceIds: Array.from(selectedIds), groupId: pickedGroupId },
      {
        onSuccess: (data) => {
          setBulkMessage(`${data.added} host gruba eklendi.`);
          setShowGroupPicker(false);
          setPickedGroupId("");
          setSelectedIds(new Set());
        }
      }
    );
  }

  function handleBulkAssignTemplate() {
    if (!pickedTemplateId || selectedIds.size === 0) return;
    bulkAssignTemplate.mutate(
      { deviceIds: Array.from(selectedIds), templateId: pickedTemplateId },
      {
        onSuccess: (data) => {
          setBulkMessage(`${data.assigned} hosta şablon atandı.`);
          setShowTemplatePicker(false);
          setPickedTemplateId("");
          setSelectedIds(new Set());
        }
      }
    );
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
          <p className="text-sm text-text-secondary">{total} cihaz</p>
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <>
              <button onClick={() => setShowGroupPicker((v) => !v)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
                Gruba ekle ({selectedIds.size})
              </button>
              <button onClick={() => setShowTemplatePicker((v) => !v)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
                Şablon uygula ({selectedIds.size})
              </button>
              <button onClick={handleBulkDelete} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-[var(--text-danger)] text-[var(--text-danger)]">
                <Trash2 size={15} />
                Sil ({selectedIds.size})
              </button>
            </>
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

      {bulkMessage && (
        <div className="text-sm bg-[var(--bg-success)] text-[var(--text-success)] p-2.5 rounded-md mb-3 flex items-center justify-between">
          {bulkMessage}
          <button onClick={() => setBulkMessage(null)} className="text-xs">Kapat</button>
        </div>
      )}

      {showGroupPicker && (
        <div className="bg-surface-2 border border-border rounded-xl p-3 mb-3 flex items-end gap-2">
          <select value={pickedGroupId} onChange={(e) => setPickedGroupId(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-56">
            <option value="">Host grubu seç</option>
            {groups?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <button onClick={handleBulkAssignGroup} disabled={!pickedGroupId} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50">
            Ekle
          </button>
        </div>
      )}

      {showTemplatePicker && (
        <div className="bg-surface-2 border border-border rounded-xl p-3 mb-3 flex items-end gap-2">
          <select value={pickedTemplateId} onChange={(e) => setPickedTemplateId(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-56">
            <option value="">Şablon seç</option>
            {templates?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button onClick={handleBulkAssignTemplate} disabled={!pickedTemplateId} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50">
            Uygula
          </button>
        </div>
      )}

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

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-3 py-2.5 border-t border-border bg-surface-1">
              <span className="text-xs text-text-secondary">
                Sayfa {page} / {totalPages} · toplam {total} cihaz
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setPage((p) => Math.max(p - 1, 1))}
                  disabled={page <= 1}
                  className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-border-strong disabled:opacity-40 disabled:cursor-not-allowed hover:bg-surface-2"
                >
                  <ChevronLeft size={13} />
                  Önceki
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
                  disabled={page >= totalPages}
                  className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-border-strong disabled:opacity-40 disabled:cursor-not-allowed hover:bg-surface-2"
                >
                  Sonraki
                  <ChevronRight size={13} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {showCreateModal && <CreateDeviceModal onClose={() => setShowCreateModal(false)} />}
      {editingDevice && <EditDeviceModal device={editingDevice} onClose={() => setEditingDevice(null)} />}
      {showScanModal && <SubnetScanModal onClose={() => setShowScanModal(false)} />}
    </div>
  );
}
