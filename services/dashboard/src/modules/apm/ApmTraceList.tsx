import { useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, GitBranch, CheckCircle2, AlertTriangle } from "lucide-react";
import { useApmTraces } from "./useApm";

const HOURS_OPTIONS = [
  { label: "Son 1 saat", hours: 1 },
  { label: "Son 6 saat", hours: 6 },
  { label: "Son 24 saat", hours: 24 },
  { label: "Son 7 gün", hours: 168 }
];

export function ApmTraceList() {
  const [searchParams] = useSearchParams();
  const [serviceName, setServiceName] = useState(searchParams.get("service_name") || "");
  const [minDuration, setMinDuration] = useState("");
  const [hours, setHours] = useState(1);
  const [errorsOnly, setErrorsOnly] = useState(false);

  useEffect(() => {
    const fromUrl = searchParams.get("service_name");
    if (fromUrl) setServiceName(fromUrl);
  }, [searchParams]);

  const { data: traces, isLoading, error } = useApmTraces({
    service_name: serviceName || undefined,
    min_duration_ms: minDuration ? Number(minDuration) : undefined,
    hours,
    limit: 100,
    errors_only: errorsOnly || undefined
  });

  return (
    <div>
      <Link to="/apm" className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-accent mb-3">
        <ArrowLeft size={15} />
        APM Servisleri
      </Link>

      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium flex items-center gap-1.5">
            <GitBranch size={18} />
            Trace Arama
          </h1>
          <p className="text-sm text-text-secondary">{traces?.length ?? 0} trace bulundu.</p>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <input
          type="text"
          placeholder="Servis adı ile filtrele..."
          value={serviceName}
          onChange={(e) => setServiceName(e.target.value)}
          className="px-3 py-2 text-sm rounded-md border border-border bg-surface-1 w-56"
        />
        <input
          type="number"
          placeholder="Min. süre (ms)"
          value={minDuration}
          onChange={(e) => setMinDuration(e.target.value)}
          className="px-3 py-2 text-sm rounded-md border border-border bg-surface-1 w-36"
        />
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="text-sm px-3 py-2 rounded-md border border-border bg-surface-1">
          {HOURS_OPTIONS.map((o) => <option key={o.hours} value={o.hours}>{o.label}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-md border border-border bg-surface-1 cursor-pointer select-none">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
          Sadece hatalılar
        </label>
      </div>

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}
      {error && <p className="text-sm text-[var(--text-danger)]">Hata: {(error as Error).message}</p>}

      {traces && (
        <div className="border border-border rounded-xl overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-1 text-text-secondary text-left">
                <th className="p-3 font-medium">Durum</th>
                <th className="p-3 font-medium">Servis</th>
                <th className="p-3 font-medium">İşlem</th>
                <th className="p-3 font-medium">Süre</th>
                <th className="p-3 font-medium">Span sayısı</th>
                <th className="p-3 font-medium">Zaman</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((t) => (
                <tr key={t.trace_id} className="border-t border-border hover:bg-surface-1">
                  <td className="p-0">
                    <Link to={`/apm/traces/${t.trace_id}`} className="flex items-center gap-1.5 p-3">
                      {t.status_code === 2 ? (
                        <AlertTriangle size={14} className="text-[var(--text-danger)]" />
                      ) : (
                        <CheckCircle2 size={14} className="text-[var(--text-success)]" />
                      )}
                    </Link>
                  </td>
                  <td className="p-0">
                    <Link to={`/apm/traces/${t.trace_id}`} className="block p-3 font-medium hover:text-text-accent">
                      {t.service_name}
                    </Link>
                  </td>
                  <td className="p-3 text-text-secondary">{t.operation_name}</td>
                  <td className="p-3 text-text-secondary">{Math.round(t.duration_ms)} ms</td>
                  <td className="p-3 text-text-secondary">{t.span_count}</td>
                  <td className="p-3 text-text-secondary text-xs">{new Date(t.timestamp).toLocaleString("tr-TR")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {traces.length === 0 && <p className="text-sm text-text-muted p-4">Trace bulunamadı.</p>}
        </div>
      )}
    </div>
  );
}
