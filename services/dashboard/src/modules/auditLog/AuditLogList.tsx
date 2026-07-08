import { useAuditLog } from "./useAuditLog";

const METHOD_COLOR: Record<string, string> = {
  POST: "text-[var(--text-success)] bg-[var(--bg-success)]",
  PATCH: "text-[var(--text-warning)] bg-[var(--bg-warning)]",
  PUT: "text-[var(--text-warning)] bg-[var(--bg-warning)]",
  DELETE: "text-[var(--text-danger)] bg-[var(--bg-danger)]"
};

export function AuditLogList() {
  const { data: entries, isLoading } = useAuditLog();

  return (
    <div>
      <h1 className="text-lg font-medium mb-1">Denetim kaydı</h1>
      <p className="text-sm text-text-secondary mb-4">Tüm değişiklik işlemlerinin (oluşturma/güncelleme/silme) otomatik kaydı</p>

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-1 text-text-secondary text-left">
              <th className="p-3 font-medium">Kullanıcı</th>
              <th className="p-3 font-medium">İşlem</th>
              <th className="p-3 font-medium">Yol</th>
              <th className="p-3 font-medium">Sonuç</th>
              <th className="p-3 font-medium">Zaman</th>
            </tr>
          </thead>
          <tbody>
            {entries?.map((e) => (
              <tr key={e.id} className="border-t border-border">
                <td className="p-3">{e.user_email}</td>
                <td className="p-3">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${METHOD_COLOR[e.method] ?? ""}`}>{e.method}</span>
                </td>
                <td className="p-3 font-mono text-xs text-text-secondary">{e.path}</td>
                <td className="p-3 text-xs text-text-secondary">{e.status_code}</td>
                <td className="p-3 text-xs text-text-muted">{new Date(e.created_at).toLocaleString("tr-TR")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz kayıt yok.</p>}
      </div>
    </div>
  );
}
