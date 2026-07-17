import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Plus, Trash2, Users as UsersIcon, Folders, Tag } from "lucide-react";
import {
  useUserGroups, useGroupMembers, useAddGroupMember, useRemoveGroupMember,
  useGroupDevicePermissions, useSetGroupDevicePermission, useDeleteGroupDevicePermission,
  useGroupTagFilters, useSetGroupTagFilter, useDeleteGroupTagFilter
} from "./useUserGroups";
import { useUsers } from "../users/useUsers";
import { useDeviceGroups } from "../deviceGroups/useDeviceGroups";

const PERMISSION_LABELS: Record<string, string> = {
  read: "Salt okunur",
  read_write: "Okuma-yazma",
  deny: "Erişim yok"
};

export function UserGroupDetail() {
  const { id } = useParams<{ id: string }>();
  const groupId = id!;
  const { data: groups } = useUserGroups();
  const group = groups?.find((g) => g.id === groupId);

  return (
    <div>
      <Link to="/user-groups" className="flex items-center gap-1.5 text-sm text-text-secondary mb-3 w-fit">
        <ArrowLeft size={15} />
        Gruplara dön
      </Link>

      <div className="mb-5">
        <h1 className="text-lg font-medium">{group?.name ?? "Yükleniyor..."}</h1>
        <p className="text-sm text-text-secondary">Üyelik, cihaz erişimi ve tag filtrelerini yönet</p>
      </div>

      <MembersSection groupId={groupId} />
      <DevicePermissionsSection groupId={groupId} />
      <TagFiltersSection groupId={groupId} />
    </div>
  );
}

function MembersSection({ groupId }: { groupId: string }) {
  const { data: members, isLoading } = useGroupMembers(groupId);
  const { data: allUsers } = useUsers();
  const addMember = useAddGroupMember(groupId);
  const removeMember = useRemoveGroupMember(groupId);
  const [selectedUserId, setSelectedUserId] = useState("");

  const memberIds = new Set(members?.map((m) => m.id) ?? []);
  const availableUsers = allUsers?.filter((u) => !memberIds.has(u.id)) ?? [];

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedUserId) return;
    addMember.mutate(selectedUserId, { onSuccess: () => setSelectedUserId("") });
  }

  return (
    <div className="mb-6">
      <div className="flex items-center gap-1.5 mb-2.5">
        <UsersIcon size={15} className="text-text-secondary" />
        <h2 className="text-sm font-medium">Üyeler</h2>
      </div>

      <form onSubmit={handleAdd} className="flex items-end gap-2 mb-3">
        <select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-64">
          <option value="">Kullanıcı seçin...</option>
          {availableUsers.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
        </select>
        <button type="submit" disabled={!selectedUserId || addMember.isPending} className="px-3 py-1.5 text-sm rounded-md border border-border-strong hover:bg-surface-1 flex items-center gap-1">
          <Plus size={14} />
          Ekle
        </button>
      </form>

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}
      <div className="border border-border rounded-xl overflow-hidden">
        {members?.map((m) => (
          <div key={m.id} className="flex items-center gap-3 px-3 py-2 border-b border-border last:border-0">
            <span className="text-sm flex-1">{m.email}</span>
            <button onClick={() => removeMember.mutate(m.id)} className="text-text-muted hover:text-[var(--text-danger)]">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {members && members.length === 0 && <p className="text-sm text-text-muted p-3">Bu grupta henüz üye yok.</p>}
      </div>
    </div>
  );
}

function DevicePermissionsSection({ groupId }: { groupId: string }) {
  const { data: permissions, isLoading } = useGroupDevicePermissions(groupId);
  const { data: deviceGroups } = useDeviceGroups();
  const setPermission = useSetGroupDevicePermission(groupId);
  const removePermission = useDeleteGroupDevicePermission(groupId);

  const [selectedDeviceGroupId, setSelectedDeviceGroupId] = useState("");
  const [permissionLevel, setPermissionLevel] = useState<"read" | "read_write" | "deny">("read");

  const assignedGroupIds = new Set(permissions?.map((p) => p.device_group_id) ?? []);
  const availableDeviceGroups = deviceGroups?.filter((dg) => !assignedGroupIds.has(dg.id)) ?? [];

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedDeviceGroupId) return;
    setPermission.mutate(
      { deviceGroupId: selectedDeviceGroupId, permission: permissionLevel },
      { onSuccess: () => setSelectedDeviceGroupId("") }
    );
  }

  return (
    <div className="mb-6">
      <div className="flex items-center gap-1.5 mb-2.5">
        <Folders size={15} className="text-text-secondary" />
        <h2 className="text-sm font-medium">Cihaz grubu erişimi</h2>
      </div>
      <p className="text-xs text-text-muted mb-3">
        Bir kullanıcı birden fazla gruba üyeyse, aynı cihaz grubu üzerinde "Erişim yok" her zaman kazanır;
        aksi halde "Okuma-yazma" &gt; "Salt okunur".
      </p>

      <form onSubmit={handleAdd} className="flex items-end gap-2 mb-3">
        <select value={selectedDeviceGroupId} onChange={(e) => setSelectedDeviceGroupId(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-56">
          <option value="">Cihaz grubu seçin...</option>
          {availableDeviceGroups.map((dg) => <option key={dg.id} value={dg.id}>{dg.name}</option>)}
        </select>
        <select value={permissionLevel} onChange={(e) => setPermissionLevel(e.target.value as any)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40">
          <option value="read">Salt okunur</option>
          <option value="read_write">Okuma-yazma</option>
          <option value="deny">Erişim yok</option>
        </select>
        <button type="submit" disabled={!selectedDeviceGroupId || setPermission.isPending} className="px-3 py-1.5 text-sm rounded-md border border-border-strong hover:bg-surface-1 flex items-center gap-1">
          <Plus size={14} />
          Ekle
        </button>
      </form>

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}
      <div className="border border-border rounded-xl overflow-hidden">
        {permissions?.map((p) => (
          <div key={p.id} className="flex items-center gap-3 px-3 py-2 border-b border-border last:border-0">
            <span className="text-sm flex-1">{p.device_group_name}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full border ${
              p.permission === "deny" ? "bg-[var(--bg-danger)] text-[var(--text-danger)] border-transparent" :
              p.permission === "read_write" ? "bg-[var(--bg-success)] text-[var(--text-success)] border-transparent" :
              "bg-surface-1 text-text-secondary border-border"
            }`}>
              {PERMISSION_LABELS[p.permission]}
            </span>
            <button onClick={() => removePermission.mutate(p.id)} className="text-text-muted hover:text-[var(--text-danger)]">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {permissions && permissions.length === 0 && (
          <p className="text-sm text-text-muted p-3">Hiç kısıtlama tanımlı değil — bu grubun üyeleri tüm cihazları görebilir.</p>
        )}
      </div>
    </div>
  );
}

function TagFiltersSection({ groupId }: { groupId: string }) {
  const { data: filters, isLoading } = useGroupTagFilters(groupId);
  const { data: deviceGroups } = useDeviceGroups();
  const setFilter = useSetGroupTagFilter(groupId);
  const removeFilter = useDeleteGroupTagFilter(groupId);

  const [selectedDeviceGroupId, setSelectedDeviceGroupId] = useState("");
  const [tag, setTag] = useState("");
  const [value, setValue] = useState("");

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedDeviceGroupId || !tag) return;
    setFilter.mutate(
      { deviceGroupId: selectedDeviceGroupId, tag, value: value || undefined },
      { onSuccess: () => { setTag(""); setValue(""); } }
    );
  }

  return (
    <div className="mb-6">
      <div className="flex items-center gap-1.5 mb-2.5">
        <Tag size={15} className="text-text-secondary" />
        <h2 className="text-sm font-medium">Tag bazlı alarm filtresi</h2>
      </div>
      <p className="text-xs text-text-muted mb-3">
        Bir cihaz grubu izniyle ilişkilendirilir — bu grubun üyeleri, seçilen cihaz grubundaki alarmların
        SADECE belirtilen tag'e (ve varsa değere) sahip olanlarını görür. Değer boş bırakılırsa, tag adının
        var olması yeterlidir.
      </p>

      <form onSubmit={handleAdd} className="flex items-end gap-2 mb-3 flex-wrap">
        <select value={selectedDeviceGroupId} onChange={(e) => setSelectedDeviceGroupId(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-56">
          <option value="">Cihaz grubu seçin...</option>
          {deviceGroups?.map((dg) => <option key={dg.id} value={dg.id}>{dg.name}</option>)}
        </select>
        <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="tag adı (örn. mysql)" className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40" />
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="değer (opsiyonel)" className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40" />
        <button type="submit" disabled={!selectedDeviceGroupId || !tag || setFilter.isPending} className="px-3 py-1.5 text-sm rounded-md border border-border-strong hover:bg-surface-1 flex items-center gap-1">
          <Plus size={14} />
          Ekle
        </button>
      </form>

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}
      <div className="border border-border rounded-xl overflow-hidden">
        {filters?.map((f) => (
          <div key={f.id} className="flex items-center gap-3 px-3 py-2 border-b border-border last:border-0">
            <span className="text-sm flex-1">
              {f.device_group_name} — <span className="font-mono text-xs">{f.tag}{f.value ? `=${f.value}` : ""}</span>
            </span>
            <button onClick={() => removeFilter.mutate(f.id)} className="text-text-muted hover:text-[var(--text-danger)]">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {filters && filters.length === 0 && <p className="text-sm text-text-muted p-3">Hiç tag filtresi tanımlı değil.</p>}
      </div>
    </div>
  );
}
