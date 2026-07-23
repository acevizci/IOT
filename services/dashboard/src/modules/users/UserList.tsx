import { useState } from "react";
import { Plus, Trash2, Users as UsersIcon, KeyRound, Bell } from "lucide-react";
import {
  useUsers, useUserRoles, useCreateUser, useUpdateUser, useDeleteUser, useResetUserPassword,
  useCreateUserRole, useDeleteUserRole, useUpdateUserRole
} from "./useUsers";
import { useUserGroups } from "../userGroups/useUserGroups";
import { Shield, Pencil, Check, X } from "lucide-react";
import { ALL_RESOURCES, type PermissionLevel, type PermissionMap } from "../../api/users";
import { UserSectionTabs } from "./UserSectionTabs";
import { UserMediaSection } from "../notifications/NotificationSettings";

export function UserList() {
  const { data: users, isLoading, error } = useUsers();
  const { data: roles } = useUserRoles();
  const { data: groups } = useUserGroups();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const resetPassword = useResetUserPassword();

  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roleId, setRoleId] = useState("");
  const [groupId, setGroupId] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editEmail, setEditEmail] = useState("");
  const [editRoleId, setEditRoleId] = useState("");
  const [editEnabled, setEditEnabled] = useState(true);

  const [resettingId, setResettingId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");

  const [notifyingId, setNotifyingId] = useState<string | null>(null);

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createUser.mutate(
      { email, password, role_id: roleId, group_id: groupId || undefined },
      { onSuccess: () => { setEmail(""); setPassword(""); setRoleId(""); setGroupId(""); setShowForm(false); } }
    );
  }

  function handleDelete(id: string, userEmail: string) {
    if (!confirm(`"${userEmail}" kullanıcısını silmek istediğine emin misin?`)) return;
    deleteUser.mutate(id);
  }

  function startEdit(u: { id: string; email: string; role_id: string | null; enabled: boolean }) {
    setEditingId(u.id);
    setEditEmail(u.email);
    setEditRoleId(u.role_id ?? "");
    setEditEnabled(u.enabled);
    setResettingId(null);
    setNotifyingId(null);
  }

  function saveEdit(id: string) {
    updateUser.mutate(
      { id, input: { email: editEmail, role_id: editRoleId || undefined, enabled: editEnabled } },
      { onSuccess: () => setEditingId(null) }
    );
  }

  function startReset(id: string) {
    setResettingId(id);
    setNewPassword("");
    setEditingId(null);
    setNotifyingId(null);
  }

  function saveReset(id: string) {
    resetPassword.mutate(
      { id, password: newPassword },
      { onSuccess: () => { setResettingId(null); setNewPassword(""); } }
    );
  }

  function toggleNotify(id: string) {
    setNotifyingId((cur) => (cur === id ? null : id));
    setEditingId(null);
    setResettingId(null);
  }

  if (error) {
    return <p className="text-sm text-[var(--text-danger)]">Bu sayfayı görüntülemek için yetkiniz yok.</p>;
  }

  return (
    <div>
      <UserSectionTabs />
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium">Kullanıcılar</h1>
          <p className="text-sm text-text-secondary">Ekip üyelerini ve rollerini yönet.</p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1 shrink-0">
          <Plus size={15} />
          Kullanıcı ekle
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-4 mb-4 flex flex-col gap-3">
          <div className="flex items-end gap-3 flex-wrap">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">E-posta</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-52" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">Şifre</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">Rol</label>
              <select value={roleId} onChange={(e) => setRoleId(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-36">
                <option value="">Seçin</option>
                {roles?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">Kullanıcı grubu (opsiyonel)</label>
              <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-44">
                <option value="">Yok</option>
                {groups?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <button type="submit" disabled={createUser.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
              Ekle
            </button>
          </div>
          {!groupId && (
            <p className="text-[11px] text-text-muted">
              Uyarı: hiçbir gruba eklenmezse bu kullanıcı varsayılan olarak HİÇBİR cihazı göremez (güvenlik gereği
              varsayılan erişim kapalıdır) -- cihaz görebilmesi için bir kullanıcı grubuna ekleyip o grupta cihaz
              grubu izinleri tanımlayın, ya da "Tüm Cihazlara Erişim" grubuna ekleyerek tüm cihazlara erişim verin.
            </p>
          )}
        </form>
      )}

      {createUser.isError && <p className="text-sm text-[var(--text-danger)] mb-3">{(createUser.error as Error).message}</p>}
      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden mb-8">
        {users?.map((u) => (
          <div key={u.id} className="px-4 py-3 border-b border-border last:border-0">
            {editingId === u.id ? (
              <div className="flex items-center gap-3 flex-wrap">
                <input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} className="text-sm px-2 py-1 rounded-md border border-border bg-surface-1 w-52" />
                <select value={editRoleId} onChange={(e) => setEditRoleId(e.target.value)} className="text-sm px-2 py-1 rounded-md border border-border bg-surface-1 w-36">
                  {roles?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
                <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <input type="checkbox" checked={editEnabled} onChange={(e) => setEditEnabled(e.target.checked)} />
                  Aktif
                </label>
                <button onClick={() => saveEdit(u.id)} className="text-[var(--text-success)]"><Check size={16} /></button>
                <button onClick={() => setEditingId(null)} className="text-text-muted"><X size={16} /></button>
                {updateUser.isError && <p className="text-xs text-[var(--text-danger)] w-full">{(updateUser.error as Error).message}</p>}
              </div>
            ) : resettingId === u.id ? (
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm w-52 truncate">{u.email}</span>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Yeni şifre (en az 8 karakter)"
                  minLength={8}
                  className="text-sm px-2 py-1 rounded-md border border-border bg-surface-1 w-56"
                />
                <button onClick={() => saveReset(u.id)} disabled={newPassword.length < 8 || resetPassword.isPending} className="text-[var(--text-success)] disabled:opacity-40"><Check size={16} /></button>
                <button onClick={() => setResettingId(null)} className="text-text-muted"><X size={16} /></button>
                {resetPassword.isError && <p className="text-xs text-[var(--text-danger)] w-full">{(resetPassword.error as Error).message}</p>}
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <UsersIcon size={16} className="text-text-secondary shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium flex items-center gap-2">
                    {u.email}
                    {!u.enabled && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--bg-danger)] text-[var(--text-danger)]">devre dışı</span>}
                  </p>
                  <p className="text-xs text-text-muted">{new Date(u.created_at).toLocaleDateString("tr-TR")} tarihinde katıldı</p>
                </div>
                <span className="text-xs px-2 py-0.5 rounded-full bg-surface-1 text-text-secondary border border-border">
                  {u.role_name ?? "Rol atanmadı"}
                </span>
                <button onClick={() => toggleNotify(u.id)} className={`hover:text-text-accent ${notifyingId === u.id ? "text-text-accent" : "text-text-muted"}`} title="Bildirim kanalları"><Bell size={14} /></button>
                <button onClick={() => startEdit(u)} className="text-text-muted hover:text-text-accent" title="Düzenle"><Pencil size={13} /></button>
                <button onClick={() => startReset(u.id)} className="text-text-muted hover:text-text-accent" title="Şifre sıfırla"><KeyRound size={14} /></button>
                <button onClick={() => handleDelete(u.id, u.email)} className="text-text-muted hover:text-[var(--text-danger)]" title="Sil"><Trash2 size={14} /></button>
              </div>
            )}
            {notifyingId === u.id && (
              <div className="mt-3 pt-3 border-t border-border">
                <UserMediaSection userId={u.id} title={`${u.email} -- bildirim kanalları`} />
              </div>
            )}
          </div>
        ))}
      </div>

      <RolesSection />
    </div>
  );
}

// FAZ 1: eski 3 sabit checkbox (cihaz/alarm/kullanıcı) yerine, her kaynak için
// ayrı bir none/read/read_write seçimi yapılan bir izin matrisi.
function PermissionMatrix({ value, onChange }: { value: PermissionMap; onChange: (resource: string, level: PermissionLevel) => void }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 w-full">
      {ALL_RESOURCES.map((r) => (
        <div key={r.key} className="flex items-center justify-between gap-2">
          <span className="text-xs text-text-secondary">{r.label}</span>
          <select
            value={value[r.key] ?? "none"}
            onChange={(e) => onChange(r.key, e.target.value as PermissionLevel)}
            className="text-xs px-1.5 py-1 rounded-md border border-border bg-surface-1"
          >
            <option value="none">Yok</option>
            <option value="read">Görüntüle</option>
            <option value="read_write">Düzenle</option>
          </select>
        </div>
      ))}
    </div>
  );
}

function permissionSummary(permissions: PermissionMap): string {
  const rw = Object.entries(permissions).filter(([, l]) => l === "read_write").length;
  const r = Object.entries(permissions).filter(([, l]) => l === "read").length;
  if (rw === 0 && r === 0) return "hiçbir yetki yok";
  return `${rw} düzenlenebilir, ${r} görüntülenebilir kaynak`;
}

function RolesSection() {
  const { data: roles, isLoading } = useUserRoles();
  const createRole = useCreateUserRole();
  const deleteRole = useDeleteUserRole();
  const updateRole = useUpdateUserRole();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<PermissionMap>({});

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPermissions, setEditPermissions] = useState<PermissionMap>({});

  function startEdit(role: { id: string; name: string; permissions: PermissionMap }) {
    setEditingId(role.id);
    setEditName(role.name);
    setEditPermissions(role.permissions);
  }

  function saveEdit(id: string) {
    updateRole.mutate(
      { id, input: { name: editName, permissions: editPermissions } },
      { onSuccess: () => setEditingId(null) }
    );
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createRole.mutate(
      { name, permissions },
      { onSuccess: () => { setName(""); setPermissions({}); setShowForm(false); } }
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-medium">Roller</h2>
          <p className="text-sm text-text-secondary">Kullanıcılara atanabilecek, kaynak bazlı yetki setleri</p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
          <Plus size={15} />
          Rol oluştur
        </button>
      </div>

      {createRole.isError && <p className="text-sm text-[var(--text-danger)] mb-3">{(createRole.error as Error).message}</p>}

      {showForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-4 mb-4">
          <div className="mb-3">
            <label className="text-xs text-text-secondary mb-1 block">Rol adı</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-52" placeholder="Operatör" />
          </div>
          <PermissionMatrix value={permissions} onChange={(resource, level) => setPermissions((p) => ({ ...p, [resource]: level }))} />
          <button type="submit" disabled={createRole.isPending} className="mt-3 px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
            Oluştur
          </button>
        </form>
      )}

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        {roles?.map((r) => (
          <div key={r.id} className="px-4 py-2.5 border-b border-border last:border-0">
            {editingId === r.id ? (
              <div>
                <div className="flex items-center gap-3 mb-3">
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} className="text-sm px-2 py-1 rounded-md border border-border bg-surface-1 w-40" />
                  <button onClick={() => saveEdit(r.id)} className="text-[var(--text-success)]"><Check size={16} /></button>
                  <button onClick={() => setEditingId(null)} className="text-text-muted"><X size={16} /></button>
                </div>
                <PermissionMatrix value={editPermissions} onChange={(resource, level) => setEditPermissions((p) => ({ ...p, [resource]: level }))} />
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <Shield size={15} className="text-text-secondary shrink-0" />
                <p className="text-sm font-medium w-32">{r.name}</p>
                <span className="text-xs text-text-muted flex-1">{permissionSummary(r.permissions)}</span>
                <button onClick={() => startEdit(r)} className="text-text-muted hover:text-text-accent"><Pencil size={13} /></button>
                <button onClick={() => deleteRole.mutate(r.id)} className="text-text-muted hover:text-[var(--text-danger)]"><Trash2 size={14} /></button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
