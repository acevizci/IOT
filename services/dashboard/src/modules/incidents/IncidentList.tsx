import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, ShieldAlert } from "lucide-react";
import { useIncidents } from "./useIncidents";
import { breakdownTooltip } from "../shared/ConfidenceBreakdown";

const PAGE_SIZE = 50;

// Confidence renklendirme: >80 yeşil (yüksek güven), 60-80 sarı (orta), <60 gri
// (düşük -- zaten likely_root_cause eşiğinin altında, alarma gerek yok).
function confidenceStyle(confidence: number): string {
  if (confidence > 80) return "bg-[var(--bg-success)] text-[var(--text-success)]";
  if (confidence > 60) return "bg-[var(--bg-warning)] text-[var(--text-warning)]";
  return "bg-surface-1 text-text-muted";
}

const STATUS_LABEL: Record<string, string> = { open: "açık", resolved: "çözüldü" };
const STATUS_STYLES: Record<string, string> = {
  open: "bg-[var(--bg-danger)] text-[var(--text-danger)]",
  resolved: "bg-[var(--bg-success)] text-[var(--text-success)]"
};

export function IncidentList() {
  const [status, setStatus] = useState<"open" | "resolved" | "">("open");
  const [page, setPage] = useState(1);

  const { data, isLoading, error } = useIncidents({
    status: status || undefined,
    limit: PAGE_SIZE,
    page
  });
  const incidents = data?.items;
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  useEffect(() => {
    setPage(1);
  }, [status]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium flex items-center gap-1.5">
            <ShieldAlert size={18} />
            Olaylar
          </h1>
          <p className="text-sm text-text-secondary">
            {total} olay — RCA confidence motorunun tespit ettiği kök-neden korelasyonları.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <select value={status} onChange={(e) => setStatus(e.target.value as "open" | "resolved" | "")} className="text-sm px-3 py-2 rounded-md border border-border bg-surface-1">
          <option value="">Durum: tümü</option>
          <option value="open">Açık</option>
          <option value="resolved">Çözüldü</option>
        </select>
      </div>

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}
      {error && <p className="text-sm text-[var(--text-danger)]">Hata: {(error as Error).message}</p>}

      {incidents && (
        <div className="border border-border rounded-xl overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-1 text-text-secondary text-left">
                <th className="p-3 font-medium">Kök neden cihazı</th>
                <th className="p-3 font-medium">Confidence</th>
                <th className="p-3 font-medium">Etkilenen alarm</th>
                <th className="p-3 font-medium">Durum</th>
                <th className="p-3 font-medium">Açılış</th>
                <th className="p-3 font-medium">Güncelleme</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((inc) => (
                <tr key={inc.id} className="border-t border-border hover:bg-surface-1">
                  <td className="p-0">
                    <Link to={`/incidents/${inc.id}`} className="block p-3 font-medium hover:text-text-accent">
                      {inc.root_cause_device_name ?? "Bilinmeyen cihaz"}
                    </Link>
                  </td>
                  <td className="p-3">
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full cursor-help ${confidenceStyle(inc.confidence)}`}
                      title={breakdownTooltip(inc, inc.confidence)}
                    >
                      {inc.confidence}
                    </span>
                  </td>
                  <td className="p-3 text-text-secondary text-xs">
                    {inc.affected_count} cihaz etkileniyor
                  </td>
                  <td className="p-3">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLES[inc.status]}`}>
                      {STATUS_LABEL[inc.status]}
                    </span>
                  </td>
                  <td className="p-3 text-text-secondary text-xs">{new Date(inc.created_at).toLocaleString("tr-TR")}</td>
                  <td className="p-3 text-text-secondary text-xs">{new Date(inc.updated_at).toLocaleString("tr-TR")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {incidents.length === 0 && <p className="text-sm text-text-muted p-4">Olay bulunamadı.</p>}

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-3 py-2.5 border-t border-border bg-surface-1">
              <span className="text-xs text-text-secondary">
                Sayfa {page} / {totalPages} · toplam {total} olay
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
                  className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-border-strong disabled:opacity-40 disabled:cursor-not-allowed hover:bg-surface-2"
                >
                  Sonraki
                  <ChevronRight size={13} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
