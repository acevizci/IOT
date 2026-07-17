import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CheckCheck, Mail, Webhook, MessageSquare, Zap, Clock } from "lucide-react";
import type { TimelineEvent } from "../../api/alerts";

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
