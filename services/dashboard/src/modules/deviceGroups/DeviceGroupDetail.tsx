import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Trash2, Plus } from "lucide-react";
import { useDeviceGroup, useAddGroupMembers, useRemoveGroupMember } from "./useDeviceGroups";
import { useGroupAppliedTemplates } from "../relations/useRelations";
import { LayoutTemplate } from "lucide-react";
import { useDevices } from "../devices/useDevices";

export function DeviceGroupDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: group, isLoading } = useDeviceGroup(id!);
  const { data: appliedTemplates } = useGroupAppliedTemplates(id!);
  const { data: allDevices } = useDevices({ limit: 200 });
  const addMembers = useAddGroupMembers();
  const removeMember = useRemoveGroupMember();

  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");

  const memberIds = new Set(group?.members.map((m) => m.id) ?? []);
  const availableDevices = allDevices?.filter((d) => !memberIds.has(d.id)) ?? [];

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedDeviceId || !id) return;
    addMembers.mutate(
      { groupId: id, deviceIds: [selectedDeviceId] },
      { onSuccess: () => { setSelectedDeviceId(""); setShowAddForm(false); } }
    );
  }

  if (isLoading) return <p className="text-sm text-text-secondary">Yükleniyor...</p>;
  if (!group) return <p className="text-sm text-text-danger">Grup bulunamadı.</p>;

  return (
    <div>
      <Link to="/device-groups" className="flex items-center gap-1.5 text-sm text-text-secondary mb-3 w-fit">
        <ArrowLeft size={15} />
        Gruplara dön
      </Link>

      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium">{group.name}</h1>
          {group.description && <p className="text-sm text-text-secondary">{group.description}</p>}
        </div>
        <button onClick={() => setShowAddForm((v) => !v)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
          <Plus size={15} />
          Cihaz ekle
        </button>
      </div>

      {showAddForm && (
        <form onSubmit={handleAdd} className="bg-surface-2 border border-border rounded-xl p-4 mb-4 flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Cihaz</label>
            <select value={selectedDeviceId} onChange={(e) => setSelectedDeviceId(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-56">
              <option value="">Seçin</option>
              {availableDevices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <button type="submit" disabled={addMembers.isPending || !selectedDeviceId} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
            Ekle
          </button>
        </form>
      )}

      {appliedTemplates && appliedTemplates.length > 0 && (
        <div className="bg-surface-1 rounded-xl p-3.5 mb-4">
          <div className="flex items-center gap-1.5 mb-2.5">
            <LayoutTemplate size={15} className="text-text-secondary" />
            <span className="text-[13px] font-medium">Bu gruba uygulanan şablonlar</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {appliedTemplates.map((t) => (
              <Link key={t.id} to={`/templates/${t.id}`} className="flex items-center gap-2 text-sm hover:opacity-80">
                <span className="text-text-accent">{t.name}</span>
                <span className="text-xs text-text-muted">— {t.applied_device_count} cihaza uygulandı</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-1 text-text-secondary text-left">
              <th className="p-3 font-medium">İsim</th>
              <th className="p-3 font-medium">IP adresi</th>
              <th className="p-3 font-medium">Tip</th>
              <th className="p-3 font-medium">Durum</th>
              <th className="p-3 font-medium w-10"></th>
            </tr>
          </thead>
          <tbody>
            {group.members.map((m) => (
              <tr key={m.id} className="border-t border-border">
                <td className="p-3 font-medium">
                  <Link to={`/devices/${m.id}`}>{m.name}</Link>
                </td>
                <td className="p-3 text-text-secondary font-mono text-xs">{m.ip_address}</td>
                <td className="p-3 text-text-secondary">{m.device_type}</td>
                <td className="p-3 text-text-secondary">{m.status}</td>
                <td className="p-3">
                  <button onClick={() => removeMember.mutate({ groupId: id!, deviceId: m.id })} className="text-text-muted hover:text-[var(--text-danger)]">
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {group.members.length === 0 && <p className="text-sm text-text-muted p-4">Bu grupta henüz cihaz yok.</p>}
      </div>
    </div>
  );
}
