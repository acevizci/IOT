import { Router, CircleCheck, AlertTriangle, Activity, ChevronRight, Search } from "lucide-react";
import { useDevices } from "../devices/useDevices";
import { useAlerts } from "../alerts/useAlerts";
import { Link } from "react-router-dom";

export function Overview() {
  const { data: devices } = useDevices({ limit: 100 });
  const { data: alerts } = useAlerts();

  const total = devices?.length ?? 0;
  const healthy = devices?.filter((d) => d.status === "active").length ?? 0;
  const openAlerts = alerts?.filter((a) => !a.resolved_at) ?? [];
  const critical = openAlerts.filter((a) => a.severity === "critical").length;

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-lg font-medium">Genel bakış</h1>
          <p className="text-[13px] text-text-secondary mt-0.5">Son güncelleme az önce</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border">
            <Search size={14} className="text-text-muted" />
            <span className="text-[13px] text-text-muted">Cihaz ara...</span>
          </div>
          <div className="w-8 h-8 rounded-full bg-[var(--bg-accent)] flex items-center justify-center text-[12px] font-medium text-[var(--text-accent)]">
            AC
          </div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-4">
        <KpiCard label="Toplam cihaz" value={total} icon={<Router size={16} />} tone="neutral" />
        <KpiCard label="Sağlıklı" value={healthy} icon={<CircleCheck size={16} />} tone="success" />
        <KpiCard label="Açık alarm" value={openAlerts.length} icon={<AlertTriangle size={16} />} tone="warning" />
        <KpiCard label="Kritik" value={critical} icon={<Activity size={16} />} tone="danger" />
      </div>

      <div className="grid grid-cols-[1.6fr_1fr] gap-4">
        <div className="bg-surface-2 border border-border rounded-xl">
          <p className="text-sm font-medium px-4 pt-3.5 pb-1">Cihazlar</p>
          {devices?.slice(0, 8).map((d, i) => (
            <Link
              key={d.id}
              to="/devices"
              className="flex items-center gap-3 px-4 py-2.5 border-t border-border text-sm hover:bg-surface-1"
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  d.status === "active" ? "bg-[var(--text-success)]" : "bg-[var(--text-warning)]"
                }`}
              />
              <span className="font-medium w-36 truncate">{d.name}</span>
              <span className="text-text-secondary w-28 shrink-0">{d.ip_address}</span>
              <Sparkline seed={i} tone={d.status === "active" ? "success" : "warning"} />
              <span
                className={`ml-auto text-xs font-medium px-2 py-0.5 rounded-full ${
                  d.status === "active"
                    ? "bg-[var(--bg-success)] text-[var(--text-success)]"
                    : "bg-[var(--bg-warning)] text-[var(--text-warning)]"
                }`}
              >
                {d.status === "active" ? "sağlıklı" : "uyarı"}
              </span>
              <ChevronRight size={15} className="text-text-muted shrink-0" />
            </Link>
          ))}
          {(!devices || devices.length === 0) && (
            <p className="text-sm text-text-muted px-4 py-6">Henüz cihaz eklenmedi.</p>
          )}
        </div>

        <div className="bg-surface-2 border border-border rounded-xl">
          <p className="text-sm font-medium px-4 pt-3.5 pb-1">Son alarmlar</p>
          {openAlerts.slice(0, 6).map((a) => (
            <div
              key={a.id}
              className="flex gap-2.5 px-4 py-2.5 border-t border-border first:border-t-0"
              style={{ borderLeft: "2px solid var(--text-warning)" }}
            >
              <div className="min-w-0 pl-1">
                <p className="text-[13px] leading-snug">{a.message}</p>
                <p className="text-xs text-text-muted mt-1">
                  {new Date(a.triggered_at).toLocaleString("tr-TR")}
                </p>
              </div>
            </div>
          ))}
          {openAlerts.length === 0 && <p className="text-sm text-text-muted px-4 py-6">Açık alarm yok.</p>}
        </div>
      </div>
    </div>
  );
}

const TONE_STYLES: Record<string, { chip: string; icon: string; value: string }> = {
  neutral: { chip: "bg-surface-0", icon: "text-text-secondary", value: "text-text-primary" },
  success: { chip: "bg-[var(--bg-success)]", icon: "text-[var(--text-success)]", value: "text-[var(--text-success)]" },
  warning: { chip: "bg-[var(--bg-warning)]", icon: "text-[var(--text-warning)]", value: "text-[var(--text-warning)]" },
  danger: { chip: "bg-[var(--bg-danger)]", icon: "text-[var(--text-danger)]", value: "text-[var(--text-danger)]" }
};

function KpiCard({
  label,
  value,
  icon,
  tone
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: "neutral" | "success" | "warning" | "danger";
}) {
  const s = TONE_STYLES[tone];
  return (
    <div className="bg-surface-1 rounded-xl p-4 border border-border">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[13px] text-text-secondary">{label}</span>
        <span className={`w-7 h-7 rounded-full flex items-center justify-center ${s.chip} ${s.icon}`}>{icon}</span>
      </div>
      <p className={`text-[26px] font-medium leading-none ${s.value}`}>{value}</p>
    </div>
  );
}

function Sparkline({ seed, tone }: { seed: number; tone: "success" | "warning" }) {
  const points = Array.from({ length: 7 }, (_, i) => {
    const n = Math.sin(seed * 3.1 + i * 1.3) * 8 + 12;
    return `${i * 10},${20 - n}`;
  }).join(" ");
  const color = tone === "success" ? "#0F6E56" : "#854F0B";
  return (
    <svg width="60" height="24" viewBox="0 0 60 24" className="shrink-0">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}
