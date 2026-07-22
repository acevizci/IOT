import { useState } from "react";
import { Link } from "react-router-dom";
import { Activity, Search } from "lucide-react";
import { useApmServices } from "./useApm";

const HOURS_OPTIONS = [
  { label: "Son 1 saat", hours: 1 },
  { label: "Son 6 saat", hours: 6 },
  { label: "Son 24 saat", hours: 24 },
  { label: "Son 7 gün", hours: 168 }
];

// Confidence renklendirmesiyle AYNI mantık (DeviceDetail.tsx, IncidentList.tsx) --
// ama burada hata oranı için TERS yönlü: düşük hata oranı iyi (yeşil), yüksek
// hata oranı kötü (kırmızı).
function errorRateStyle(pct: number): string {
  if (pct > 5) return "bg-[var(--bg-danger)] text-[var(--text-danger)]";
  if (pct > 1) return "bg-[var(--bg-warning)] text-[var(--text-warning)]";
  return "bg-[var(--bg-success)] text-[var(--text-success)]";
}

export function ApmServiceList() {
  const [hours, setHours] = useState(1);
  const { data: services, isLoading, error } = useApmServices({ hours });

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium flex items-center gap-1.5">
            <Activity size={18} />
            APM — Servisler
          </h1>
          <p className="text-sm text-text-secondary">
            OpenTelemetry ile toplanan servis performans metrikleri (RED: Rate, Errors, Duration).
          </p>
        </div>
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="text-sm px-3 py-2 rounded-md border border-border bg-surface-1">
          {HOURS_OPTIONS.map((o) => <option key={o.hours} value={o.hours}>{o.label}</option>)}
        </select>
      </div>

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}
      {error && <p className="text-sm text-[var(--text-danger)]">Hata: {(error as Error).message}</p>}

      {services && (
        <div className="border border-border rounded-xl overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-1 text-text-secondary text-left">
                <th className="p-3 font-medium">Servis</th>
                <th className="p-3 font-medium">İstek/dk</th>
                <th className="p-3 font-medium">Hata oranı</th>
                <th className="p-3 font-medium">p50</th>
                <th className="p-3 font-medium">p95</th>
                <th className="p-3 font-medium">p99</th>
                <th className="p-3 font-medium w-16"></th>
              </tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.service_name} className="border-t border-border hover:bg-surface-1">
                  <td className="p-3 font-medium">{s.service_name}</td>
                  <td className="p-3 text-text-secondary">{s.requests_per_min}</td>
                  <td className="p-3">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${errorRateStyle(s.error_rate_pct)}`}>
                      %{s.error_rate_pct}
                    </span>
                  </td>
                  <td className="p-3 text-text-secondary">{s.p50_ms} ms</td>
                  <td className="p-3 text-text-secondary">{s.p95_ms} ms</td>
                  <td className="p-3 text-text-secondary">{s.p99_ms} ms</td>
                  <td className="p-3">
                    <Link
                      to={`/apm/traces?service_name=${encodeURIComponent(s.service_name)}`}
                      className="flex items-center gap-1 text-xs text-text-accent hover:underline"
                    >
                      <Search size={12} />
                      Trace'ler
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {services.length === 0 && <p className="text-sm text-text-muted p-4">Henüz APM verisi yok.</p>}
        </div>
      )}
    </div>
  );
}
