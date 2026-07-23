import { useState, Fragment } from "react";
import { Link } from "react-router-dom";
import { Activity, Search, ChevronDown, ChevronRight } from "lucide-react";
import { ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { useApmServices, useApmServiceTrend } from "./useApm";

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
  const [expanded, setExpanded] = useState<string | null>(null);
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
                <th className="p-3 font-medium w-8"></th>
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
                <Fragment key={s.service_name}>
                <tr
                  className="border-t border-border hover:bg-surface-1 cursor-pointer"
                  onClick={() => setExpanded((cur) => (cur === s.service_name ? null : s.service_name))}
                >
                  <td className="p-3 text-text-muted">
                    {expanded === s.service_name ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </td>
                  <td className="p-3 font-medium">
                    {s.device_id ? (
                      <Link
                        to={`/devices/${s.device_id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="hover:text-text-accent"
                        title="Bu servisin bağlı olduğu host'u/RCA bağlamını gör"
                      >
                        {s.service_name}
                      </Link>
                    ) : (
                      s.service_name
                    )}
                  </td>
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
                      onClick={(e) => e.stopPropagation()}
                      className="flex items-center gap-1 text-xs text-text-accent hover:underline"
                    >
                      <Search size={12} />
                      Trace'ler
                    </Link>
                  </td>
                </tr>
                {expanded === s.service_name && (
                  <tr className="border-t border-border bg-surface-1">
                    <td colSpan={8} className="p-3">
                      <ApmTrendChart serviceName={s.service_name} hours={hours} />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {services.length === 0 && <p className="text-sm text-text-muted p-4">Henüz APM verisi yok.</p>}
        </div>
      )}
    </div>
  );
}

// GERÇEK EKSİKLİK: servis listesi sadece seçili aralığın TOPLU değerini
// gösteriyordu -- "gecikme artıyor mu" sorusuna görsel bir yanıt yoktu.
// GraphWidget'taki çift Y-eksen deseniyle AYNI fikir: hata oranı (sol, %) ve
// p95 gecikme (sağ, ms) tek grafikte, farklı ölçeklerde okunabilir şekilde.
function ApmTrendChart({ serviceName, hours }: { serviceName: string; hours: number }) {
  const { data, isLoading } = useApmServiceTrend(serviceName, hours, true);

  if (isLoading) return <p className="text-xs text-text-muted">Trend yükleniyor...</p>;
  if (!data || data.length < 2) return <p className="text-xs text-text-muted">Bu aralıkta trend çizmek için yeterli veri yok.</p>;

  const chartData = data.map((p) => ({
    time: new Date(p.bucket.replace(" ", "T") + "Z").toLocaleString("tr-TR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }),
    error_rate_pct: p.error_rate_pct,
    p95_ms: p.p95_ms
  }));

  return (
    <div>
      <p className="text-xs text-text-secondary mb-2">
        {serviceName} — hata oranı ve p95 gecikme zaman içinde
      </p>
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--text-secondary)" }} />
          <YAxis yAxisId="left" tick={{ fontSize: 10, fill: "var(--text-secondary)" }} label={{ value: "% hata", angle: -90, fontSize: 10, position: "insideLeft" }} />
          <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: "var(--text-secondary)" }} label={{ value: "p95 ms", angle: 90, fontSize: 10, position: "insideRight" }} />
          <Tooltip contentStyle={{ background: "var(--surface-1)", border: "1px solid var(--border)", fontSize: 12 }} />
          <Line yAxisId="left" type="monotone" dataKey="error_rate_pct" name="Hata oranı (%)" stroke="var(--text-danger)" strokeWidth={2} dot={false} />
          <Line yAxisId="right" type="monotone" dataKey="p95_ms" name="p95 (ms)" stroke="var(--text-accent)" strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
