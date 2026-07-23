import { useParams, Link } from "react-router-dom";
import { ArrowLeft, ShieldAlert, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useIncidentDetail } from "./useIncidents";
import { ConfidenceBreakdownPanel, PathChain } from "../shared/ConfidenceBreakdown";

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

export function IncidentDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useIncidentDetail(id!);

  if (isLoading) return <p className="text-sm text-text-secondary">Yükleniyor...</p>;
  if (error) return <p className="text-sm text-[var(--text-danger)]">Hata: {(error as Error).message}</p>;
  if (!data) return null;

  const pathSteps = (data.path_device_ids ?? []).map((id, i) => ({ id, name: data.path_device_names?.[i] ?? "(bilinmeyen cihaz)" }));

  return (
    <div>
      <Link to="/incidents" className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-accent mb-3">
        <ArrowLeft size={15} />
        Olaylar
      </Link>

      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium flex items-center gap-1.5">
            <ShieldAlert size={18} />
            {data.root_cause_device_name ?? "Bilinmeyen cihaz"} — olası kök neden
          </h1>
          <p className="text-sm text-text-secondary">
            Bu cihazdaki bir sorunun, aşağıdaki alarmların olası kök nedeni olduğu RCA confidence motoru tarafından tespit edildi.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLES[data.status]}`}>
            {STATUS_LABEL[data.status]}
          </span>
          <span className={`text-sm font-medium px-2.5 py-1 rounded-full ${confidenceStyle(data.confidence)}`}>
            confidence: {data.confidence}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-surface-2 border border-border rounded-xl p-4">
          <p className="text-sm font-medium mb-3">Kök neden</p>
          {data.root_cause_device_id ? (
            <Link to={`/devices/${data.root_cause_device_id}`} className="font-medium hover:text-text-accent text-sm">
              {data.root_cause_device_name}
            </Link>
          ) : (
            <p className="text-sm text-text-muted">Cihaz silinmiş.</p>
          )}
          {data.root_cause_alert_message && (
            <div className="mt-2 text-xs text-text-secondary flex items-start gap-1.5">
              {data.root_cause_alert_resolved_at ? (
                <CheckCircle2 size={13} className="text-[var(--text-success)] mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle size={13} className="text-[var(--text-warning)] mt-0.5 shrink-0" />
              )}
              <div>
                <p>{data.root_cause_alert_message}</p>
                {data.root_cause_alert_triggered_at && (
                  <p className="text-text-muted mt-0.5">{new Date(data.root_cause_alert_triggered_at).toLocaleString("tr-TR")}</p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="bg-surface-2 border border-border rounded-xl p-4">
          <p className="text-sm font-medium mb-3">Zaman çizelgesi</p>
          <div className="text-xs text-text-secondary flex flex-col gap-1">
            <p>Açıldı: {new Date(data.created_at).toLocaleString("tr-TR")}</p>
            <p>Son güncelleme: {new Date(data.updated_at).toLocaleString("tr-TR")}</p>
            {data.resolved_at && <p>Çözüldü: {new Date(data.resolved_at).toLocaleString("tr-TR")}</p>}
          </div>
        </div>
      </div>

      <div className="bg-surface-2 border border-border rounded-xl p-4 mt-4">
        <p className="text-sm font-medium mb-1">Neden bu cihaz?</p>
        <p className="text-xs text-text-secondary mb-3">
          Confidence skoru, dört bileşenin çarpımından oluşuyor. Yüksek skor için hepsi yüksek olmalı.
        </p>
        <ConfidenceBreakdownPanel breakdown={data} confidence={data.confidence} />
        {pathSteps.length > 1 && (
          <div className="mt-3">
            <p className="text-[11px] text-text-secondary mb-1.5">Bağlantı zinciri</p>
            <PathChain steps={pathSteps} />
          </div>
        )}
      </div>

      <div className="bg-surface-2 border border-border rounded-xl p-4 mt-4">
        <p className="text-sm font-medium mb-3">Etkilenen cihazlar ({data.affected_alerts.length})</p>
        <div className="flex flex-col gap-2.5">
          {data.affected_alerts.map((a) => (
            <Link key={a.id} to={`/alerts/${a.alert_id}`} className="flex items-start gap-2 text-xs hover:opacity-80">
              {a.alert_resolved_at ? (
                <CheckCircle2 size={13} className="text-[var(--text-success)] mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle size={13} className="text-[var(--text-warning)] mt-0.5 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <p><span className="font-medium">{a.device_name}</span> — {a.alert_message}</p>
                <p className="text-text-muted mt-0.5">{new Date(a.alert_triggered_at).toLocaleString("tr-TR")}</p>
              </div>
              <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${confidenceStyle(a.confidence)}`} title="Bu alarmın kök nedene bağlanma confidence'ı">
                {a.confidence}
              </span>
            </Link>
          ))}
          {data.affected_alerts.length === 0 && <p className="text-xs text-text-muted">Henüz etkilenen alarm yok.</p>}
        </div>
      </div>
    </div>
  );
}
