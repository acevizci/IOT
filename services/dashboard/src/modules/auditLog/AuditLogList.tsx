import { Fragment, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ChevronLeft } from "lucide-react";
import { useAuditLog } from "./useAuditLog";

const METHOD_COLOR: Record<string, string> = {
  POST: "text-[var(--text-success)] bg-[var(--bg-success)]",
  PATCH: "text-[var(--text-warning)] bg-[var(--bg-warning)]",
  PUT: "text-[var(--text-warning)] bg-[var(--bg-warning)]",
  DELETE: "text-[var(--text-danger)] bg-[var(--bg-danger)]"
};

const PAGE_SIZE = 50;

export function AuditLogList() {
  const [method, setMethod] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useAuditLog({
    method: method || undefined,
    user_email: userEmail || undefined,
    page,
    limit: PAGE_SIZE
  });
  const entries = data?.items;
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  useEffect(() => {
    setPage(1);
  }, [method, userEmail]);

  return (
    <div>
      <h1 className="text-lg font-medium mb-1">Denetim kaydı</h1>
      <p className="text-sm text-text-secondary mb-4">
        Tüm değişiklik işlemlerinin (oluşturma/güncelleme/silme) otomatik kaydı — bir satıra tıklayınca
        gönderilen veri ve sonucu görebilirsin.
      </p>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <select value={method} onChange={(e) => setMethod(e.target.value)} className="text-sm px-3 py-2 rounded-md border border-border bg-surface-1">
          <option value="">İşlem: tümü</option>
          <option value="POST">POST</option>
          <option value="PATCH">PATCH</option>
          <option value="PUT">PUT</option>
          <option value="DELETE">DELETE</option>
        </select>
        <input
          value={userEmail}
          onChange={(e) => setUserEmail(e.target.value)}
          placeholder="kullanıcı e-postası ile filtrele..."
          className="text-sm px-3 py-2 rounded-md border border-border bg-surface-1 w-64"
        />
        {(method || userEmail) && (
          <button onClick={() => { setMethod(""); setUserEmail(""); }} className="text-xs px-3 py-2 rounded-md border border-border-strong hover:bg-surface-2">
            Sıfırla
          </button>
        )}
      </div>

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-1 text-text-secondary text-left">
              <th className="p-3 font-medium w-6"></th>
              <th className="p-3 font-medium">Kullanıcı</th>
              <th className="p-3 font-medium">İşlem</th>
              <th className="p-3 font-medium">Yol</th>
              <th className="p-3 font-medium">Sonuç</th>
              <th className="p-3 font-medium">Zaman</th>
            </tr>
          </thead>
          <tbody>
            {entries?.map((e) => {
              const hasDetail = e.request_body || e.response_body;
              const isExpanded = expandedId === e.id;
              return (
                <Fragment key={e.id}>
                  <tr
                    className={`border-t border-border ${hasDetail ? "cursor-pointer hover:bg-surface-1" : ""}`}
                    onClick={() => hasDetail && setExpandedId(isExpanded ? null : e.id)}
                  >
                    <td className="p-3 text-text-muted">
                      {hasDetail && (isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
                    </td>
                    <td className="p-3">{e.user_email}</td>
                    <td className="p-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${METHOD_COLOR[e.method] ?? ""}`}>{e.method}</span>
                    </td>
                    <td className="p-3 font-mono text-xs text-text-secondary">{e.path}</td>
                    <td className="p-3 text-xs text-text-secondary">{e.status_code}</td>
                    <td className="p-3 text-xs text-text-muted">{new Date(e.created_at).toLocaleString("tr-TR")}</td>
                  </tr>
                  {isExpanded && hasDetail && (
                    <tr className="bg-surface-1 border-t border-border">
                      <td></td>
                      <td colSpan={5} className="p-3">
                        <div className="grid grid-cols-2 gap-3">
                          {e.request_body && (
                            <div>
                              <p className="text-xs text-text-secondary mb-1">Gönderilen veri</p>
                              <pre className="text-xs bg-surface-2 border border-border rounded-md p-2.5 overflow-x-auto font-mono">
                                {JSON.stringify(e.request_body, null, 2)}
                              </pre>
                            </div>
                          )}
                          {e.response_body && (
                            <div>
                              <p className="text-xs text-text-secondary mb-1">Sonuç</p>
                              <pre className="text-xs bg-surface-2 border border-border rounded-md p-2.5 overflow-x-auto font-mono">
                                {JSON.stringify(e.response_body, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {entries?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz kayıt yok.</p>}

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-3 py-2.5 border-t border-border bg-surface-1">
            <span className="text-xs text-text-secondary">
              Sayfa {page} / {totalPages} · toplam {total} kayıt
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
                className="text-xs px-2.5 py-1.5 rounded-md border border-border-strong disabled:opacity-40 disabled:cursor-not-allowed hover:bg-surface-2"
              >
                Sonraki
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
