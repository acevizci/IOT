import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, CheckCheck, Mail, Webhook, MessageSquare, Zap, Clock } from "lucide-react";
import type { TimelineEvent } from "../../api/alerts";
import { useAlertDetail } from "./useAlerts";

const CONDITION_LABEL: Record<string, string> = { gt: ">", lt: "<", eq: "=" };

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}sn`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}dk`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}s ${m % 60}dk`;
  const d = Math.floor(h / 24);
  return `${d}g ${h % 24}s`;
}

export function formatClock(dateStr: string): string {
  return new Date(dateStr).toLocaleString("tr-TR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
}

export interface EventDescription {
  icon: ReactNode;
  dotClass: string;
  title: string;
  detail?: ReactNode;
}

// Bir timeline olayını (tetiklenme/bildirim/eskalasyon/üstlenme/not/çözülme) simge +
// renk + başlık + detaya çevirir. AlertDetail (tam sayfa) ve AlertList (satır-içi
// hover önizlemesi) AYNI mantığı kullanır -- iki yerde ayrı ayrı bakım gerekmesin diye.
export function describeEvent(event: TimelineEvent, compact = false): EventDescription {
  switch (event.type) {
    case "triggered":
      return {
        icon: <AlertTriangle size={compact ? 12 : 14} />,
        dotClass: "bg-[var(--text-danger)] text-[var(--text-danger)]",
        title: "Alarm tetiklendi",
        detail: !compact && (
          <p className="text-xs text-text-secondary mt-0.5">
            Ölçülen değer <span className="font-mono">{event.value ?? "—"}</span>
            {event.condition && event.threshold != null && (
              <> · eşik: {CONDITION_LABEL[event.condition]} <span className="font-mono">{event.threshold}</span></>
            )}
          </p>
        )
      };
    case "notification":
    case "escalation_notification": {
      const ChannelIcon = event.channel_type === "email" ? Mail : Webhook;
      const isEscalation = event.type === "escalation_notification";
      const failed = event.status === "failed";
      return {
        icon: isEscalation ? <Zap size={compact ? 12 : 14} /> : <ChannelIcon size={compact ? 12 : 14} />,
        dotClass: failed
          ? "bg-[var(--text-danger)] text-[var(--text-danger)]"
          : isEscalation
            ? "bg-[var(--text-warning)] text-[var(--text-warning)]"
            : "bg-[var(--text-accent)] text-[var(--text-accent)]",
        title: isEscalation ? `Eskalasyon adım ${event.step_order} bildirimi` : "Bildirim gönderildi",
        detail: (
          <div className="text-xs text-text-secondary mt-0.5">
            {!compact && <span className="truncate">{event.destination}</span>}
            <span className={`${compact ? "" : "ml-2"} px-1.5 py-0.5 rounded ${failed ? "bg-[var(--bg-danger)] text-[var(--text-danger)]" : "bg-[var(--bg-success)] text-[var(--text-success)]"}`}>
              {failed ? "başarısız" : "gönderildi"}
            </span>
            {!compact && event.error_message && <p className="text-[var(--text-danger)] mt-0.5">{event.error_message}</p>}
          </div>
        )
      };
    }
    case "acknowledged":
      return {
        icon: <CheckCheck size={compact ? 12 : 14} />,
        dotClass: "bg-[var(--text-accent)] text-[var(--text-accent)]",
        title: `${event.user_email ?? "Bir kullanıcı"} üstlendi`
      };
    case "comment":
      return {
        icon: <MessageSquare size={compact ? 12 : 14} />,
        dotClass: "bg-surface-1 border border-border-strong text-text-secondary",
        title: event.user_email ?? "Not",
        detail: <p className="text-xs text-text-secondary mt-0.5 line-clamp-2">{event.comment}</p>
      };
    case "resolved":
      return {
        icon: <CheckCircle2 size={compact ? 12 : 14} />,
        dotClass: "bg-[var(--text-success)] text-[var(--text-success)]",
        title: "Alarm çözüldü"
      };
    default:
      return { icon: <Clock size={compact ? 12 : 14} />, dotClass: "bg-surface-1 border border-border", title: event.type };
  }
}

// PAYLAŞILAN hover-geçmiş davranışı: hem alarm listesi tablosunda hem dashboard
// widget'larında (ProblemListWidget) AYNI "üzerine gel, kompakt timeline'ı gör"
// deneyimini sağlar. Popover fixed-positioned'dır (kapsayıcı overflow-hidden/
// overflow-y-auto olsa bile kırpılmasın diye) ve veri SADECE hover edildiğinde
// çekilir (React Query enabled bayrağı) -- önceden görülmüş bir alarm cache'ten
// anında gelir.
export function useHistoryHoverPreview() {
  const [hoverInfo, setHoverInfo] = useState<{ id: string; top: number; left: number } | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleEnter(alertId: string, e: React.MouseEvent<HTMLElement>) {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    const rect = e.currentTarget.getBoundingClientRect();
    setHoverInfo({ id: alertId, top: rect.bottom + 6, left: rect.left });
  }
  function handleLeave() {
    timeoutRef.current = setTimeout(() => setHoverInfo(null), 150);
  }
  function cancelLeave() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }

  return { hoverInfo, handleEnter, handleLeave, cancelLeave };
}

export function HistoryPreviewPopover({ alertId }: { alertId: string }) {
  const { data: alert, isLoading } = useAlertDetail(alertId);

  return (
    <div className="w-72 max-h-80 overflow-y-auto bg-surface-1 border border-border-strong rounded-xl shadow-lg p-3.5">
      {isLoading && <p className="text-xs text-text-secondary">Yükleniyor...</p>}
      {alert && (
        <div className="relative pl-5">
          <div className="absolute left-[5px] top-1 bottom-1 w-px bg-[var(--border-strong)]" />
          {(alert.timeline ?? []).map((event, i) => {
            const { icon, dotClass, title } = describeEvent(event, true);
            const offsetMs = new Date(event.timestamp).getTime() - new Date(alert.triggered_at).getTime();
            return (
              <div key={i} className="relative pb-3 last:pb-0">
                <div className={`absolute -left-5 top-0.5 w-2.5 h-2.5 rounded-full ${dotClass}`} />
                <div className="flex items-center gap-1.5">
                  <span className="text-text-secondary shrink-0">{icon}</span>
                  <span className="text-xs truncate">{title}</span>
                </div>
                <p className="text-[10px] text-text-muted mt-0.5 font-mono">
                  {offsetMs <= 0 ? "tetiklendi" : `+${formatDuration(offsetMs)}`} · {formatClock(event.timestamp)}
                </p>
              </div>
            );
          })}
          {(!alert.timeline || alert.timeline.length === 0) && <p className="text-xs text-text-muted">Kayıt yok.</p>}
        </div>
      )}
    </div>
  );
}

// Popover'ı, hangi bileşen kullanıyorsa onun en dışına (JSX ağacının sonuna)
// eklenmesi gereken hazır sarmalayıcı -- position:fixed ile konumlanır.
// document.body'ye PORTAL ile render edilir: dashboard widget'ları
// (react-grid-layout) kendi konumlandırması için CSS transform kullanıyor --
// transform'lu bir atanın İÇİNDE position:fixed olan bir eleman, viewport'a
// göre değil O ATAYA göre konumlanır (CSS'in bilinen bir tuzağı). Portal,
// popover'ı DOM ağacında o transform'lu atanın dışına (body'ye) taşıyarak
// bunu önler.
export function HistoryHoverOverlay({
  hoverInfo, onMouseEnter, onMouseLeave
}: {
  hoverInfo: { id: string; top: number; left: number } | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  if (!hoverInfo) return null;
  return createPortal(
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ position: "fixed", top: hoverInfo.top, left: Math.max(hoverInfo.left - 260, 8), zIndex: 50 }}
    >
      <HistoryPreviewPopover alertId={hoverInfo.id} />
    </div>,
    document.body
  );
}
