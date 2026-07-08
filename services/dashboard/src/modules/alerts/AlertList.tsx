import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { useAlerts } from "./useAlerts";
import { SEVERITY_LABEL } from "../shared/severity";

export function AlertList() {
  const [filter, setFilter] = useState<"open" | "resolved" | undefined>("open");
  const { data: alerts, isLoading } = useAlerts(filter);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-medium">Alarmlar</h1>
        <div className="flex gap-1 bg-surface-1 rounded-md p-1 border border-border">
          <FilterTab label="Açık" active={filter === "open"} onClick={() => setFilter("open")} />
          <FilterTab label="Çözüldü" active={filter === "resolved"} onClick={() => setFilter("resolved")} />
          <FilterTab label="Tümü" active={filter === undefined} onClick={() => setFilter(undefined)} />
        </div>
      </div>

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden bg-surface-2">
        {alerts?.map((a) => (
          <Link
            key={a.id}
            to={`/devices/${a.device_id}`}
            className="flex items-start gap-3 px-4 py-3 border-b border-border last:border-0 hover:bg-surface-1"
            style={{ borderLeft: `3px solid ${a.resolved_at ? "var(--text-success)" : "var(--text-warning)"}` }}
          >
            {a.resolved_at ? (
              <CheckCircle2 size={16} className="text-[var(--text-success)] mt-0.5 shrink-0" />
            ) : (
              <AlertTriangle size={16} className="text-[var(--text-warning)] mt-0.5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm">{a.message}</p>
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-surface-0 text-text-secondary border border-border shrink-0">
                  {SEVERITY_LABEL[a.severity] ?? a.severity}
                </span>
              </div>
              <p className="text-xs text-text-muted mt-1">
                {a.device_name ?? "Bilinmeyen cihaz"} · {a.metric_name} · {new Date(a.triggered_at).toLocaleString("tr-TR")}
                {a.resolved_at && ` · çözüldü: ${new Date(a.resolved_at).toLocaleString("tr-TR")}`}
              </p>
            </div>
          </Link>
        ))}
        {alerts?.length === 0 && <p className="text-sm text-text-muted p-4">Bu filtrede alarm yok.</p>}
      </div>
    </div>
  );
}

function FilterTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`text-xs px-3 py-1.5 rounded ${active ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
      {label}
    </button>
  );
}
