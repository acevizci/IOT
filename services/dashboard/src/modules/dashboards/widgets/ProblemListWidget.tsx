import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CheckCheck, History } from "lucide-react";
import { apiFetch } from "../../../api/client";
import { useHistoryHoverPreview, HistoryHoverOverlay } from "../../alerts/timelineUtils";

interface Alert {
  id: string;
  device_id: string;
  device_name?: string;
  metric_name: string;
  severity: string;
  triggered_at: string;
  acknowledged_at: string | null;
  tags?: Array<{ tag: string; value: string }>;
  recurrence_count?: number;
}

const SEVERITY_BG: Record<string, string> = {
  info: "rgba(107,114,128,0.12)", warning: "rgba(245,158,11,0.16)", average: "rgba(249,115,22,0.18)",
  high: "rgba(239,68,68,0.20)", disaster: "rgba(153,27,27,0.25)"
};

function formatDuration(triggeredAt: string): string {
  const ms = Date.now() - new Date(triggeredAt).getTime();
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}g ${hours}s ${minutes}dk`;
  if (hours > 0) return `${hours}s ${minutes}dk`;
  return `${minutes}dk`;
}

function formatDateGroup(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function ProblemListWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const limit = config.limit || 5;
  const groupQs = config.device_group_id ? `&device_group_id=${config.device_group_id}` : "";
  const { data, isLoading } = useQuery({
    queryKey: ["widget-problem-list", limit, config.device_group_id],
    queryFn: () => apiFetch<{ items: Alert[] }>(`/api/v1/alerts?status=open&limit=${limit}${groupQs}`),
    refetchInterval: 30000
  });

  const items = data?.items || [];
  const { hoverInfo, handleEnter, handleLeave, cancelLeave } = useHistoryHoverPreview();

  // Ardışık aynı-tarihli satırları grupluyoruz (Zabbix'in "Problems" listesindeki
  // tarih ayırıcısı deseni) — her yeni tarihte bir başlık satırı ekleniyor.
  let lastDateGroup = "";

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary mb-1">{title || "Açık Alarmlar"}</p>
      {items.length > 0 && (
        <div className="flex items-center gap-2 text-[9px] text-text-muted uppercase tracking-wide px-1.5 pb-1 border-b border-border">
          <span className="flex-1">Sorun / Cihaz</span>
          <span className="shrink-0 w-12 text-right">Süre</span>
          <span className="w-3 shrink-0" />
          <span className="w-3 shrink-0" />
        </div>
      )}
      {isLoading && <p className="text-xs text-text-muted">Yükleniyor...</p>}
      <div className="flex-1 overflow-y-auto flex flex-col">
        {items.map((a) => {
          const dateGroup = formatDateGroup(a.triggered_at);
          const showDateHeader = dateGroup !== lastDateGroup;
          lastDateGroup = dateGroup;
          return (
            <div key={a.id}>
              {showDateHeader && (
                <p className="text-[10px] text-text-muted mt-1.5 mb-0.5">{dateGroup}</p>
              )}
              <Link
                to={`/alerts/${a.id}`}
                className="flex items-center gap-2 text-xs px-1.5 py-1.5 rounded hover:opacity-90 border-b border-white/40"
                style={{ backgroundColor: SEVERITY_BG[a.severity] || "transparent" }}
              >
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{a.metric_name}</span>
                    {(a.recurrence_count ?? 1) > 1 && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-surface-1 text-text-muted shrink-0" title="Son 7 günde bu sorun kaç kez oluştu">
                        ×{a.recurrence_count}
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] text-text-muted truncate block">{a.device_name}</span>
                </span>
                <span className="text-[10px] text-text-muted shrink-0">{formatDuration(a.triggered_at)}</span>
                {a.acknowledged_at ? (
                  <span title="Üstlenildi" className="shrink-0"><CheckCheck size={12} className="text-[var(--text-success)]" /></span>
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <span
                  onMouseEnter={(e) => handleEnter(a.id, e)}
                  onMouseLeave={handleLeave}
                  className="shrink-0 text-text-muted hover:text-text-accent"
                  title="Geçmişi göster"
                >
                  <History size={12} />
                </span>
              </Link>
              {(a.tags ?? []).length > 0 && (
                <div className="flex gap-1 flex-wrap pl-1.5 mb-1">
                  {(a.tags ?? []).map((t, i) => (
                    <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-surface-1 text-text-muted">{t.tag}:{t.value}</span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {items.length === 0 && !isLoading && <p className="text-xs text-text-muted">Açık alarm yok.</p>}
      </div>
      <HistoryHoverOverlay hoverInfo={hoverInfo} onMouseEnter={cancelLeave} onMouseLeave={handleLeave} />
    </div>
  );
}
