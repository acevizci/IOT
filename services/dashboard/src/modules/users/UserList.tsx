import { useState } from "react";
import { Plus, Trash2, Users as UsersIcon } from "lucide-react";
import { useUsers, useUserRoles, useCreateUser, useDeleteUser } from "./useUsers";

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
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium">Kullanıcılar</h1>
          <p className="text-sm text-text-secondary">Ekip üyelerini ve yetkilerini yönet</p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
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

      <div className="border border-border rounded-xl overflow-hidden">
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
    </div>
  );
}
