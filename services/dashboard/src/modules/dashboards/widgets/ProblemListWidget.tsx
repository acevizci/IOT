import { useState, Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CheckCheck, History, ChevronLeft, ChevronRight, Sparkles, TrendingUp } from "lucide-react";
import { apiFetch } from "../../../api/client";
import { useHistoryHoverPreview, HistoryHoverOverlay } from "../../alerts/timelineUtils";
import { resolveRefreshInterval } from "./refreshInterval";

// Kullanıcı kararı: Önem ayrı bir sütun/rozet DEĞİL, satır arka plan rengiyle
// gösteriliyor (Zabbix'in "Problems" listesindeki AYNI mantık) -- ayrı bir
// metin rozeti dar widget genişliğinde gereksiz yer kaplıyordu.
const SEVERITY_BG: Record<string, string> = {
  info: "rgba(107,114,128,0.12)", warning: "rgba(245,158,11,0.16)", average: "rgba(249,115,22,0.18)",
  high: "rgba(239,68,68,0.20)", disaster: "rgba(153,27,27,0.25)", critical: "rgba(122,18,48,0.32)"
};

interface Alert {
  id: string;
  device_id: string;
  device_name?: string;
  metric_name: string;
  message: string;
  severity: string;
  triggered_at: string;
  acknowledged_at: string | null;
  tags?: Array<{ tag: string; value: string }>;
  recurrence_count?: number;
  // Anomali Tespiti: rolling z-score tabanlı istatistiksel alarm.
  is_anomaly?: boolean;
  // Predictive Analytics: doğrusal regresyon tabanlı trend tahmini.
  is_predictive?: boolean;
}

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

// Kullanıcı isteği: ana Alarmlar sayfasındaki (AlertList.tsx) sütun başlıklarıyla
// (Problem/Cihaz/Süre/Ack/Etiketler) AYNI görünüm -- önceden widget'ta bu başlıklar
// hiç yoktu, "Sorun / Cihaz" gibi tek bir birleşik sütun vardı. Önem, ayrı bir sütun
// yerine satır arka plan rengiyle gösteriliyor (kullanıcı kararı).
export function ProblemListWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const limit = config.limit || 5;
  const groupQs = config.device_group_id ? `&device_group_id=${config.device_group_id}` : "";
  const [page, setPage] = useState(1);
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["widget-problem-list", limit, config.device_group_id, page],
    queryFn: () => apiFetch<{ items: Alert[]; total: number; totalPages: number }>(`/api/v1/alerts?status=open&limit=${limit}&page=${page}${groupQs}`),
    refetchInterval: resolveRefreshInterval(config, 30000)
  });

  const items = data?.items || [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;
  const { hoverInfo, handleEnter, handleLeave, cancelLeave } = useHistoryHoverPreview();

  // Ardışık aynı-tarihli satırları grupluyoruz (Zabbix'in "Problems" listesindeki
  // tarih ayırıcısı deseni) — her yeni tarihte bir başlık satırı ekleniyor.
  let lastDateGroup = "";

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs text-text-secondary">{title || "Açık Alarmlar"}</p>
        {total > 0 && <p className="text-[10px] text-text-muted">{total} alarm</p>}
      </div>
      {isLoading && <p className="text-xs text-text-muted">Yükleniyor...</p>}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs border-collapse">
          {items.length > 0 && (
            <thead>
              <tr className="text-[9px] text-text-muted uppercase tracking-wide border-b border-border">
                <th className="text-left font-normal pb-1 pl-1.5">Problem</th>
                <th className="text-left font-normal pb-1 px-1.5">Cihaz</th>
                <th className="text-right font-normal pb-1 px-1.5 w-14">Süre</th>
                <th className="text-center font-normal pb-1 w-8">Ack</th>
                <th className="text-left font-normal pb-1 pr-1">Etiketler</th>
              </tr>
            </thead>
          )}
          <tbody>
            {items.map((a) => {
              const dateGroup = formatDateGroup(a.triggered_at);
              const showDateHeader = dateGroup !== lastDateGroup;
              lastDateGroup = dateGroup;
              return (
                <Fragment key={a.id}>
                  {showDateHeader && (
                    <tr>
                      <td colSpan={5} className="text-[10px] text-text-muted pt-1.5 pb-0.5">{dateGroup}</td>
                    </tr>
                  )}
                  <tr
                    onClick={() => navigate(`/alerts/${a.id}`)}
                    className="border-b border-white/40 hover:opacity-90 cursor-pointer"
                    style={{ backgroundColor: SEVERITY_BG[a.severity] || "transparent" }}
                  >
                    <td className="py-1.5 pl-1.5 align-top max-w-0">
                      <div className="flex items-center justify-between gap-1.5" title={a.message}>
                        <span className="truncate font-medium">{a.message || a.metric_name}</span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {a.is_anomaly && (
                            <span title="Rolling z-score tabanlı istatistiksel anomali" className="shrink-0 text-text-accent">
                              <Sparkles size={10} />
                            </span>
                          )}
                          {a.is_predictive && (
                            <span title="Doğrusal regresyon tabanlı trend tahmini" className="shrink-0 text-text-accent">
                              <TrendingUp size={10} />
                            </span>
                          )}
                          {(a.recurrence_count ?? 1) > 1 && (
                            <span className="text-[9px] px-1 py-0.5 rounded bg-surface-1 text-text-muted shrink-0" title="Son 7 günde bu sorun kaç kez oluştu">
                              ×{a.recurrence_count}
                            </span>
                          )}
                          <span
                            onClick={(e) => e.stopPropagation()}
                            onMouseEnter={(e) => handleEnter(a.id, e)}
                            onMouseLeave={handleLeave}
                            className="shrink-0 text-text-muted hover:text-text-accent"
                            title="Geçmişi göster"
                          >
                            <History size={11} />
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="py-1.5 px-1.5 align-top text-text-muted truncate max-w-0">{a.device_name}</td>
                    <td className="py-1.5 px-1.5 align-top text-right text-text-muted whitespace-nowrap">{formatDuration(a.triggered_at)}</td>
                    <td className="py-1.5 align-top text-center">
                      {a.acknowledged_at && (
                        <span title="Üstlenildi"><CheckCheck size={12} className="text-[var(--text-success)] inline" /></span>
                      )}
                    </td>
                    <td className="py-1.5 pr-1 align-top">
                      <div className="flex gap-1 flex-wrap">
                        {(a.tags ?? []).map((t, i) => (
                          <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-surface-1 text-text-muted whitespace-nowrap">{t.tag}:{t.value}</span>
                        ))}
                      </div>
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {items.length === 0 && !isLoading && <p className="text-xs text-text-muted p-1">Açık alarm yok.</p>}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-1 mt-1 border-t border-border shrink-0">
          <span className="text-[10px] text-text-muted">{page}/{totalPages}</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(p - 1, 1))}
              disabled={page <= 1}
              className="p-0.5 rounded hover:bg-surface-2 disabled:opacity-30 disabled:cursor-not-allowed text-text-secondary"
            >
              <ChevronLeft size={13} />
            </button>
            <button
              onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
              disabled={page >= totalPages}
              className="p-0.5 rounded hover:bg-surface-2 disabled:opacity-30 disabled:cursor-not-allowed text-text-secondary"
            >
              <ChevronRight size={13} />
            </button>
          </div>
        </div>
      )}
      <HistoryHoverOverlay hoverInfo={hoverInfo} onMouseEnter={cancelLeave} onMouseLeave={handleLeave} />
    </div>
  );
}
