import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import { ArrowLeft, AlertTriangle, CheckCircle2, CheckCheck, Send, XCircle } from "lucide-react";
import { useAlertDetail, useAcknowledgeAlert, useUnacknowledgeAlert, useAddAlertComment, useUpdateAlertSeverity, useResolveAlert } from "./useAlerts";
import { useMetrics } from "../devices/useMetrics";
import { SEVERITY_LABEL, SEVERITY_STYLES, SEVERITY_LEVELS } from "../shared/severity";
import { Sparkles, TrendingUp } from "lucide-react";
import { formatDuration, formatClock, describeEvent } from "./timelineUtils";
import type { TimelineEvent } from "../../api/alerts";

const CONDITION_LABEL: Record<string, string> = { gt: ">", lt: "<", eq: "=" };

export function AlertDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: alert, isLoading } = useAlertDetail(id!);
  const acknowledge = useAcknowledgeAlert(id!);
  const updateSeverity = useUpdateAlertSeverity(id!);
  const unacknowledge = useUnacknowledgeAlert(id!);
  const resolve = useResolveAlert(id!);
  const addComment = useAddAlertComment(id!);
  const [commentText, setCommentText] = useState("");

  const chartRange = alert
    ? {
        from: new Date(new Date(alert.triggered_at).getTime() - 60 * 60 * 1000).toISOString(),
        to: alert.resolved_at
          ? new Date(new Date(alert.resolved_at).getTime() + 60 * 60 * 1000).toISOString()
          : new Date().toISOString()
      }
    : undefined;

  const { data: metricsData } = useMetrics(
    alert?.device_id ?? "",
    alert?.metric_name ?? undefined,
    6,
    undefined,
    chartRange
  );

  function handleAddComment(e: React.FormEvent) {
    e.preventDefault();
    if (!commentText.trim()) return;
    addComment.mutate(commentText, { onSuccess: () => setCommentText("") });
  }

  if (isLoading) return <p className="text-sm text-text-secondary">Yükleniyor...</p>;
  if (!alert) return <p className="text-sm text-[var(--text-danger)]">Alarm bulunamadı.</p>;

  const chartData = (metricsData?.rows ?? []).map((p) => ({
    time: formatClock(p.time),
    value: Number(p.value.toFixed(2))
  }));

  const isOpen = !alert.resolved_at;
  const triggeredAt = new Date(alert.triggered_at).getTime();
  const lifespanMs = (alert.resolved_at ? new Date(alert.resolved_at).getTime() : Date.now()) - triggeredAt;

  return (
    <div>
      <Link to="/alerts" className="flex items-center gap-1.5 text-sm text-text-secondary mb-3 w-fit">
        <ArrowLeft size={15} />
        Alarmlara dön
      </Link>

      <div className="flex items-start justify-between mb-4 gap-4">
        <div className="flex items-start gap-3 min-w-0">
          {alert.resolved_at ? (
            <CheckCircle2 size={22} className="text-[var(--text-success)] mt-0.5 shrink-0" />
          ) : (
            <AlertTriangle size={22} className="text-[var(--text-warning)] mt-0.5 shrink-0" />
          )}
          <div className="min-w-0">
            <h1 className="text-lg font-medium break-words">{alert.message}</h1>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <select
                value={alert.severity}
                onChange={(e) => updateSeverity.mutate(e.target.value)}
                disabled={updateSeverity.isPending}
                title="Severity'yi değiştir"
                className={`text-xs font-medium pl-2 pr-1 py-0.5 rounded-full border-none cursor-pointer appearance-none ${SEVERITY_STYLES[alert.severity] ?? ""}`}
              >
                {SEVERITY_LEVELS.map((s) => (
                  <option key={s} value={s}>{SEVERITY_LABEL[s] ?? s}</option>
                ))}
              </select>
              {alert.is_anomaly && (
                <span
                  title="Rolling z-score tabanlı istatistiksel anomali (sabit bir eşik değil, geçmiş davranışa göre sapma tespiti)"
                  className="flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-surface-2 text-text-accent border border-border"
                >
                  <Sparkles size={12} />
                  Anomali
                </span>
              )}
              {alert.is_predictive && (
                <span
                  title="Doğrusal regresyon tabanlı trend tahmini (mevcut trend devam ederse eşiği ne zaman aşacağının öngörüsü)"
                  className="flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-surface-2 text-text-accent border border-border"
                >
                  <TrendingUp size={12} />
                  Tahmin
                </span>
              )}
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full flex items-center gap-1 ${isOpen ? "bg-[var(--bg-warning)] text-[var(--text-warning)]" : "bg-[var(--bg-success)] text-[var(--text-success)]"}`}>
                {isOpen && <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--text-warning)] opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[var(--text-warning)]"></span>
                </span>}
                {isOpen ? `açık · ${formatDuration(lifespanMs)}` : `çözüldü · ${formatDuration(lifespanMs)} sürdü`}
              </span>
              {alert.from_template && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-surface-2 text-text-muted">şablondan</span>
              )}
            </div>
          </div>
        </div>

        <div className="shrink-0 flex items-center gap-2">
          {alert.acknowledged_at ? (
            <button onClick={() => unacknowledge.mutate()} disabled={unacknowledge.isPending} className="text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
              Üstlenmeyi geri al
            </button>
          ) : (
            <button onClick={() => acknowledge.mutate()} disabled={acknowledge.isPending} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-[var(--text-accent)] text-white">
              <CheckCheck size={15} />
              Üstlen
            </button>
          )}
          {isOpen && (
            <button
              onClick={() => { if (confirm("Bu alarmı manuel olarak çözüldü işaretlemek istediğinize emin misiniz? Sorun devam ediyorsa bir sonraki değerlendirme turunda yeniden açılabilir.")) resolve.mutate(); }}
              disabled={resolve.isPending}
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-[var(--text-success)] text-[var(--text-success)] hover:bg-[var(--bg-success)]"
            >
              <CheckCircle2 size={15} />
              Manuel çözüldü işaretle
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-5">
        <InfoCard label="Cihaz">
          {alert.device_id ? (
            <Link to={`/devices/${alert.device_id}`} className="text-sm font-medium text-text-accent">{alert.device_name}</Link>
          ) : (
            <span className="text-sm text-text-muted">Cihaz silinmiş</span>
          )}
          {alert.ip_address && <p className="text-xs text-text-secondary font-mono mt-0.5">{alert.ip_address}</p>}
        </InfoCard>
        <InfoCard label="Kural">
          <p className="text-sm font-medium">{alert.metric_name}</p>
          <p className="text-xs text-text-secondary mt-0.5">
            {alert.condition && CONDITION_LABEL[alert.condition]} {alert.threshold} · {alert.duration_seconds}s boyunca
          </p>
        </InfoCard>
        <InfoCard label="Ölçülen değer">
          <p className="text-sm font-medium font-mono">{alert.value ?? "—"}</p>
          <p className="text-xs text-text-secondary mt-0.5">tetiklenme anında</p>
        </InfoCard>
      </div>

      {alert.metric_name && (
        <div className="bg-surface-2 border border-border rounded-xl p-4 mb-5">
          <p className="text-sm font-medium mb-3">
            {alert.metric_name}
            <span className="text-text-secondary font-normal"> — tetiklenme anının bağlamı</span>
          </p>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="time" tick={{ fontSize: 11, fill: "var(--text-secondary)" }} />
              <YAxis tick={{ fontSize: 12, fill: "var(--text-secondary)" }} />
              <Tooltip contentStyle={{ background: "var(--surface-1)", border: "1px solid var(--border)", fontSize: 13 }} />
              {alert.threshold !== null && (
                <ReferenceLine y={alert.threshold} stroke="var(--text-danger)" strokeDasharray="4 4" label={{ value: "eşik", fontSize: 11, fill: "var(--text-danger)" }} />
              )}
              <Line type="monotone" dataKey="value" stroke="var(--text-accent)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
          {chartData.length === 0 && <p className="text-sm text-text-muted py-6 text-center">Bu aralıkta veri bulunamadı.</p>}
        </div>
      )}

      <AlertTimeline
        timeline={alert.timeline ?? []}
        isOpen={isOpen}
        triggeredAt={triggeredAt}
        commentText={commentText}
        setCommentText={setCommentText}
        onAddComment={handleAddComment}
        addCommentPending={addComment.isPending}
      />

      {alert.suppressed_by_this.length > 0 && (
        <div className="bg-surface-2 border border-border rounded-xl p-4 mt-5">
          <p className="text-sm font-medium mb-3 flex items-center gap-1.5 text-text-secondary">
            <XCircle size={14} />
            Bu alarmın bastırdığı diğer alarmlar
          </p>
          <div className="flex flex-col gap-2">
            {alert.suppressed_by_this.map((s) => (
              <div key={s.id} className="text-xs">
                <p>{s.metric_name}</p>
                <p className="text-text-muted">{new Date(s.suppressed_at).toLocaleString("tr-TR")}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function InfoCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface-1 rounded-xl p-3.5 border border-border">
      <p className="text-xs text-text-secondary mb-1.5">{label}</p>
      {children}
    </div>
  );
}

function AlertTimeline({
  timeline, isOpen, triggeredAt, commentText, setCommentText, onAddComment, addCommentPending
}: {
  timeline: TimelineEvent[];
  isOpen: boolean;
  triggeredAt: number;
  commentText: string;
  setCommentText: (v: string) => void;
  onAddComment: (e: React.FormEvent) => void;
  addCommentPending: boolean;
}) {
  return (
    <div className="bg-surface-2 border border-border rounded-xl p-5">
      <p className="text-sm font-medium mb-5">Geçmiş</p>
      <div className="relative pl-6">
        <div className="absolute left-[7px] top-1.5 bottom-1.5 w-px bg-[var(--border-strong)]" />

        {timeline.map((event, i) => (
          <TimelineNode
            key={i}
            event={event}
            isLastAndOpen={i === timeline.length - 1 && isOpen}
            offsetMs={new Date(event.timestamp).getTime() - triggeredAt}
          />
        ))}

        <div className="relative pb-1">
          <div className="absolute -left-6 top-1.5 w-3.5 h-3.5 rounded-full bg-surface-2 border-2 border-dashed border-[var(--border-strong)]" />
          <form onSubmit={onAddComment} className="flex items-end gap-2 pt-0.5">
            <input
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Bir not ekle..."
              className="flex-1 px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
            />
            <button type="submit" disabled={!commentText.trim() || addCommentPending} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50 shrink-0">
              <Send size={14} />
              Gönder
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function TimelineNode({ event, isLastAndOpen, offsetMs }: { event: TimelineEvent; isLastAndOpen: boolean; offsetMs: number }) {
  const { icon, dotClass, title, detail } = describeEvent(event);
  const offsetLabel = offsetMs <= 0 ? "tetiklendi" : `+${formatDuration(offsetMs)}`;

  return (
    <div className="relative pb-5 last:pb-0">
      <div className={`absolute -left-6 top-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center ${dotClass}`}>
        {isLastAndOpen && (
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60" style={{ background: "currentColor" }} />
        )}
      </div>
      <div className="flex items-start gap-2">
        <div className="mt-0.5 shrink-0 text-text-secondary">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm">{title}</span>
            <span className="text-[11px] font-mono text-text-muted px-1.5 py-0.5 rounded bg-surface-1 border border-border shrink-0">{offsetLabel}</span>
          </div>
          {detail}
          <p className="text-[11px] text-text-muted mt-0.5">{formatClock(event.timestamp)}</p>
        </div>
      </div>
    </div>
  );
}
