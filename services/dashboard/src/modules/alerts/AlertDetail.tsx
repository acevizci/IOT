import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import {
  ArrowLeft, AlertTriangle, CheckCircle2, CheckCheck, Mail, Webhook,
  ShieldOff, MessageSquare, Send
} from "lucide-react";
import { useAlertDetail, useAcknowledgeAlert, useUnacknowledgeAlert, useAddAlertComment, useUpdateAlertSeverity } from "./useAlerts";
import { useMetrics } from "../devices/useMetrics";
import { SEVERITY_LABEL, SEVERITY_STYLES, SEVERITY_LEVELS } from "../shared/severity";

const CONDITION_LABEL: Record<string, string> = { gt: ">", lt: "<", eq: "=" };

export function AlertDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: alert, isLoading } = useAlertDetail(id!);
  const acknowledge = useAcknowledgeAlert(id!);
  const updateSeverity = useUpdateAlertSeverity(id!);
  const unacknowledge = useUnacknowledgeAlert(id!);
  const addComment = useAddAlertComment(id!);
  const [commentText, setCommentText] = useState("");

  // Alarmın tetiklendiği anın etrafına bir bağlam penceresi: tetiklenmeden 1 saat önce
  // başlayıp, çözüldüyse çözülmeden 1 saat sonrasına, hâlâ açıksa şu ana kadar.
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
    time: new Date(p.time).toLocaleString("tr-TR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }),
    value: Number(p.value.toFixed(2))
  }));

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
              {/* Bir alarmın severity'sini SONRADAN elle değiştirebilme (triage) -- otomatik
                  tetiklenen bir alarmın gerçek önem derecesi, kural tanımındaki sabit
                  severity'den farklı değerlendirilebilir. */}
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
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${alert.resolved_at ? "bg-[var(--bg-success)] text-[var(--text-success)]" : "bg-[var(--bg-warning)] text-[var(--text-warning)]"}`}>
                {alert.resolved_at ? "çözüldü" : "açık"}
              </span>
              {alert.from_template && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-surface-2 text-text-muted">şablondan</span>
              )}
              {alert.acknowledged_at && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--bg-accent)] text-[var(--text-accent)] flex items-center gap-1">
                  <CheckCheck size={12} />
                  {alert.acknowledged_by_email} tarafından üstlenildi
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="shrink-0">
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
        <InfoCard label="Zaman çizelgesi">
          <p className="text-xs text-text-secondary">Tetiklendi: {new Date(alert.triggered_at).toLocaleString("tr-TR")}</p>
          {alert.resolved_at && <p className="text-xs text-text-secondary">Çözüldü: {new Date(alert.resolved_at).toLocaleString("tr-TR")}</p>}
        </InfoCard>
      </div>

      {alert.metric_name && (
        <div className="bg-surface-2 border border-border rounded-xl p-4 mb-5">
          <p className="text-sm font-medium mb-3">
            {alert.metric_name}
            <span className="text-text-secondary font-normal"> — tetiklenme anının bağlamı</span>
          </p>
          <ResponsiveContainer width="100%" height={220}>
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

      <div className="grid grid-cols-2 gap-4 mb-5">
        <div className="bg-surface-2 border border-border rounded-xl p-4">
          <p className="text-sm font-medium mb-3">Bildirim gönderim geçmişi</p>
          {alert.notification_deliveries.length === 0 && <p className="text-xs text-text-muted">Bu alarm için hiç bildirim denemesi kaydı yok.</p>}
          <div className="flex flex-col gap-2">
            {alert.notification_deliveries.map((d) => (
              <div key={d.id} className="flex items-start gap-2 text-xs">
                {d.channel_type === "email" ? <Mail size={13} className="mt-0.5 shrink-0 text-text-secondary" /> : <Webhook size={13} className="mt-0.5 shrink-0 text-text-secondary" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate">{d.destination}</span>
                    <span className={`px-1.5 py-0.5 rounded shrink-0 ${d.status === "sent" ? "bg-[var(--bg-success)] text-[var(--text-success)]" : "bg-[var(--bg-danger)] text-[var(--text-danger)]"}`}>
                      {d.status === "sent" ? "gönderildi" : "başarısız"}
                    </span>
                  </div>
                  <p className="text-text-muted mt-0.5">{new Date(d.sent_at).toLocaleString("tr-TR")}</p>
                  {d.error_message && <p className="text-[var(--text-danger)] mt-0.5">{d.error_message}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-surface-2 border border-border rounded-xl p-4">
          <p className="text-sm font-medium mb-3 flex items-center gap-1.5">
            <ShieldOff size={14} />
            Bu alarmın bastırdığı alarmlar
          </p>
          {alert.suppressed_by_this.length === 0 && <p className="text-xs text-text-muted">Bu alarm nedeniyle bastırılmış başka bir alarm yok.</p>}
          <div className="flex flex-col gap-2">
            {alert.suppressed_by_this.map((s) => (
              <div key={s.id} className="text-xs">
                <p>{s.metric_name}</p>
                <p className="text-text-muted">{new Date(s.suppressed_at).toLocaleString("tr-TR")}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-surface-2 border border-border rounded-xl p-4">
        <p className="text-sm font-medium mb-3 flex items-center gap-1.5">
          <MessageSquare size={14} />
          Notlar
        </p>
        <div className="flex flex-col gap-3 mb-3">
          {alert.comments.map((c) => (
            <div key={c.id} className="text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{c.user_email}</span>
                <span className="text-xs text-text-muted">{new Date(c.created_at).toLocaleString("tr-TR")}</span>
              </div>
              <p className="text-text-secondary mt-0.5">{c.comment}</p>
            </div>
          ))}
          {alert.comments.length === 0 && <p className="text-xs text-text-muted">Henüz not eklenmedi.</p>}
        </div>
        <form onSubmit={handleAddComment} className="flex items-end gap-2">
          <input
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="Bir not ekle..."
            className="flex-1 px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
          />
          <button type="submit" disabled={!commentText.trim() || addComment.isPending} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50">
            <Send size={14} />
            Gönder
          </button>
        </form>
      </div>
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
