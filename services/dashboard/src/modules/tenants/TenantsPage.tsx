import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { UserSectionTabs } from "../users/UserSectionTabs";
import { useTenants, useCreateTenant, useDeleteTenant } from "./useTenants";

// Platform superadmin sayfası -- mevcut tenant-scoped Kullanıcılar/Kullanıcı grupları
// sekmelerinin yanına eklenen, cross-tenant bir yönetim ekranı. Sadece
// users.is_superadmin=true olan hesaba görünür (bkz. UserSectionTabs.tsx).
export function TenantsPage() {
  const { data: tenants, isLoading, error } = useTenants();
  const createTenant = useCreateTenant();
  const deleteTenant = useDeleteTenant();
  const [showForm, setShowForm] = useState(false);
  const [tenantName, setTenantName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createTenant.mutate(
      { tenantName, email, password },
      {
        onSuccess: () => {
          setTenantName("");
          setEmail("");
          setPassword("");
          setShowForm(false);
        }
      }
    );
  }

  function handleDelete(t: { id: string; name: string; user_count: number; device_count: number }) {
    if (
      !confirm(
        `"${t.name}" kalıcı olarak silinsin mi? ${t.user_count} kullanıcı, ${t.device_count} cihaz dahil TÜM verisi geri alınamaz şekilde silinecek.`
      )
    )
      return;
    deleteTenant.mutate(t.id);
  }

  if (error) {
    return <p className="text-sm text-[var(--text-danger)]">Bu sayfayı görüntülemek için superadmin yetkiniz yok.</p>;
  }

  return (
    <div>
      <UserSectionTabs />
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium">Tenant'lar</h1>
          <p className="text-sm text-text-secondary">
            Platformdaki tüm tenant'lar (kurumlar/siteler) -- diğer tenant'ların verisi normal
            kullanıcılara asla görünmez, bu sayfa sadece platform superadmin'e özeldir.
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1 shrink-0"
        >
          <Plus size={15} />
          Tenant ekle
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-2xl p-4 mb-4 flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-3">
            <input
              value={tenantName}
              onChange={(e) => setTenantName(e.target.value)}
              placeholder="Tenant adı"
              required
              className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
            />
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              placeholder="İlk admin e-posta"
              required
              className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
            />
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder="Şifre (en az 8 karakter)"
              required
              minLength={8}
              className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
            />
          </div>
          {createTenant.isError && <p className="text-sm text-[var(--text-danger)]">{(createTenant.error as Error).message}</p>}
          <button
            type="submit"
            disabled={createTenant.isPending}
            className="self-start px-3.5 py-1.5 text-sm rounded-lg bg-[var(--text-accent)] text-white hover:opacity-90 disabled:opacity-50"
          >
            {createTenant.isPending ? "Oluşturuluyor..." : "Oluştur"}
          </button>
        </form>
      )}

      {isLoading ? (
        <p className="text-sm text-text-secondary">Yükleniyor...</p>
      ) : (
        <div className="border border-border rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-1 text-text-secondary text-left border-b border-border">
                <th className="p-2.5 font-medium">Tenant</th>
                <th className="p-2.5 font-medium text-right">Kullanıcı</th>
                <th className="p-2.5 font-medium text-right">Cihaz</th>
                <th className="p-2.5 font-medium text-right">Proxy</th>
                <th className="p-2.5 font-medium">Oluşturulma</th>
                <th className="p-2.5 font-medium w-10" />
              </tr>
            </thead>
            <tbody>
              {tenants?.map((t) => (
                <tr key={t.id} className="border-b border-border last:border-0">
                  <td className="p-2.5 font-medium">{t.name}</td>
                  <td className="p-2.5 text-right text-text-muted">{t.user_count}</td>
                  <td className="p-2.5 text-right text-text-muted">{t.device_count}</td>
                  <td className="p-2.5 text-right text-text-muted">{t.proxy_count}</td>
                  <td className="p-2.5 text-text-muted">{new Date(t.created_at).toLocaleDateString("tr-TR")}</td>
                  <td className="p-2.5">
                    <button onClick={() => handleDelete(t)} className="text-text-muted hover:text-[var(--text-danger)]" title="Sil">
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
              {tenants?.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-4 text-center text-text-muted">Henüz bir tenant yok.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
