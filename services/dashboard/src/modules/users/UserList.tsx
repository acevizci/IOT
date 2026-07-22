import { useState } from "react";
import { Plus, Trash2, Users as UsersIcon } from "lucide-react";
import { useUsers, useUserRoles, useCreateUser, useDeleteUser, useCreateUserRole, useDeleteUserRole, useUpdateUserRole } from "./useUsers";
import { Shield, Pencil, Check, X } from "lucide-react";
import { ALL_RESOURCES, type PermissionLevel, type PermissionMap } from "../../api/users";
import { UserSectionTabs } from "./UserSectionTabs";

export function UserList() {
  const { data: users, isLoading, error } = useUsers();
  const { data: roles } = useUserRoles();
  const createUser = useCreateUser();
  const deleteUser = useDeleteUser();

  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roleId, setRoleId] = useState("");

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createUser.mutate(
      { email, password, role_id: roleId },
      { onSuccess: () => { setEmail(""); setPassword(""); setRoleId(""); setShowForm(false); } }
    );
  }

  function handleDelete(id: string, userEmail: string) {
    if (!confirm(`"${userEmail}" kullanıcısını silmek istediğine emin misin?`)) return;
    deleteUser.mutate(id);
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
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-4 mb-4 flex items-end gap-3">
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
          <button type="submit" disabled={createUser.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
            Ekle
          </button>
        </form>
      )}

      {createUser.isError && <p className="text-sm text-[var(--text-danger)] mb-3">{(createUser.error as Error).message}</p>}
      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden mb-8">
        {users?.map((u) => (
          <div key={u.id} className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-0">
            <UsersIcon size={16} className="text-text-secondary shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium">{u.email}</p>
              <p className="text-xs text-text-muted">{new Date(u.created_at).toLocaleDateString("tr-TR")} tarihinde katıldı</p>
            </div>
            <span className="text-xs px-2 py-0.5 rounded-full bg-surface-1 text-text-secondary border border-border">
              {u.role_name ?? "Rol atanmadı"}
            </span>
            <button onClick={() => handleDelete(u.id, u.email)} className="text-text-muted hover:text-[var(--text-danger)]">
              <Trash2 size={14} />
            </button>
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
