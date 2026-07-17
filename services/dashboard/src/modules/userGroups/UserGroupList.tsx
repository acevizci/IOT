import { useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Trash2, UsersRound } from "lucide-react";
import { useUserGroups, useCreateUserGroup, useDeleteUserGroup } from "./useUserGroups";
import { LdapSettingsPanel } from "./LdapSettingsPanel";

const FRONTEND_ACCESS_LABELS: Record<string, string> = {
  system_default: "Sistem varsayılanı",
  internal: "Dahili (email+şifre)",
  ldap: "LDAP",
  disabled: "Devre dışı"
};

export function UserGroupList() {
  const { data: groups, isLoading, error } = useUserGroups();
  const createGroup = useCreateUserGroup();
  const deleteGroup = useDeleteUserGroup();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [frontendAccess, setFrontendAccess] = useState("system_default");

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createGroup.mutate(
      { name, frontend_access: frontendAccess },
      { onSuccess: () => { setName(""); setFrontendAccess("system_default"); setShowForm(false); } }
    );
  }

  function handleDelete(id: string, groupName: string) {
    if (!confirm(`"${groupName}" grubunu silmek istediğine emin misin? Üyelerin cihaz erişimi etkilenecek.`)) return;
    deleteGroup.mutate(id);
  }

  if (error) {
    return <p className="text-sm text-[var(--text-danger)]">Bu sayfayı görüntülemek için yetkiniz yok.</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium">Kullanıcı grupları</h1>
          <p className="text-sm text-text-secondary">
            Bir kullanıcı birden fazla gruba üye olabilir. Grup, hangi cihaz gruplarının görülebileceğini
            (Read/Read-write/Deny) ve giriş yöntemini (LDAP vb.) belirler — yetki seviyesi ise ayrıca "Roller"den atanır.
          </p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1 shrink-0">
          <Plus size={15} />
          Grup oluştur
        </button>
      </div>

      {createGroup.isError && <p className="text-sm text-[var(--text-danger)] mb-3">{(createGroup.error as Error).message}</p>}

      {showForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-4 mb-4 flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Grup adı</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-48" placeholder="Saha Ekibi A" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Giriş yöntemi</label>
            <select value={frontendAccess} onChange={(e) => setFrontendAccess(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-44">
              {Object.entries(FRONTEND_ACCESS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <button type="submit" disabled={createGroup.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
            Oluştur
          </button>
        </form>
      )}

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <LdapSettingsPanel />

      <div className="border border-border rounded-xl overflow-hidden">
        {groups?.map((g) => (
          <div key={g.id} className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-0">
            <UsersRound size={16} className="text-text-secondary shrink-0" />
            <Link to={`/user-groups/${g.id}`} className="flex-1">
              <p className="text-sm font-medium text-text-accent">{g.name}</p>
              <p className="text-xs text-text-muted">{g.member_count ?? 0} üye</p>
            </Link>
            {!g.enabled && <span className="text-xs px-2 py-0.5 rounded-full bg-surface-1 text-text-muted border border-border">devre dışı</span>}
            <span className="text-xs px-2 py-0.5 rounded-full bg-surface-1 text-text-secondary border border-border">
              {FRONTEND_ACCESS_LABELS[g.frontend_access] ?? g.frontend_access}
            </span>
            <button onClick={() => handleDelete(g.id, g.name)} className="text-text-muted hover:text-[var(--text-danger)]">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {groups && groups.length === 0 && <p className="text-sm text-text-muted p-4">Henüz kullanıcı grubu yok.</p>}
      </div>
    </div>
  );
}
