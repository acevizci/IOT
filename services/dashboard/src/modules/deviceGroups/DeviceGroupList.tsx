import { useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Trash2, Folders } from "lucide-react";
import { useDeviceGroups, useCreateDeviceGroup, useDeleteDeviceGroup } from "./useDeviceGroups";

export function DeviceGroupList() {
  const { data: groups, isLoading } = useDeviceGroups();
  const createGroup = useCreateDeviceGroup();
  const deleteGroup = useDeleteDeviceGroup();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createGroup.mutate(
      { name, description: description || undefined },
      { onSuccess: () => { setName(""); setDescription(""); setShowForm(false); } }
    );
  }

  function handleDelete(id: string, groupName: string) {
    if (!confirm(`"${groupName}" grubunu silmek istediğine emin misin? (Cihazlar silinmez, sadece gruptan çıkarılır.)`)) return;
    deleteGroup.mutate(id);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium">Host grupları</h1>
          <p className="text-sm text-text-secondary">Cihazları organize etmek için gruplar oluştur</p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
          <Plus size={15} />
          Grup oluştur
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-4 mb-4 flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Grup adı</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-56" placeholder="Production Switches" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Açıklama (opsiyonel)</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-72" />
          </div>
          <button type="submit" disabled={createGroup.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
            Oluştur
          </button>
        </form>
      )}

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        {groups?.map((g) => (
          <div key={g.id} className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-0 hover:bg-surface-1">
            <Folders size={16} className="text-text-secondary shrink-0" />
            <Link to={`/device-groups/${g.id}`} className="flex-1 min-w-0">
              <p className="text-sm font-medium">{g.name}</p>
              {g.description && <p className="text-xs text-text-muted">{g.description}</p>}
            </Link>
            <span className="text-xs text-text-secondary shrink-0">{g.member_count ?? 0} cihaz</span>
            <button onClick={() => handleDelete(g.id, g.name)} className="text-text-muted hover:text-[var(--text-danger)] shrink-0">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {groups?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz grup oluşturulmadı.</p>}
      </div>
    </div>
  );
}
