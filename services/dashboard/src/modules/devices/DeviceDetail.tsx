import { useState, useEffect, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { useMetricNames, useMetrics } from "./useMetrics";

const RANGE_OPTIONS = [
  { label: "1 saat", hours: 1 },
  { label: "6 saat", hours: 6 },
  { label: "24 saat", hours: 24 },
  { label: "7 gün", hours: 168 }
];

export function DeviceDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: metricEntries } = useMetricNames(id!);
  const [selectedMetric, setSelectedMetric] = useState<string>("");
  const [selectedInterface, setSelectedInterface] = useState<string | undefined>(undefined);
  const [hours, setHours] = useState(6);

  const uniqueMetricNames = useMemo(
    () => Array.from(new Set(metricEntries?.map((m) => m.metric_name) ?? [])),
    [metricEntries]
  );

  const interfacesForMetric = useMemo(
    () =>
      metricEntries
        ?.filter((m) => m.metric_name === selectedMetric && m.interface)
        .map((m) => m.interface as string) ?? [],
    [metricEntries, selectedMetric]
  );

  useEffect(() => {
    if (uniqueMetricNames.length > 0 && !selectedMetric) {
      setSelectedMetric(uniqueMetricNames[0]);
    }
  }, [uniqueMetricNames]);

  useEffect(() => {
    setSelectedInterface(interfacesForMetric.length > 0 ? interfacesForMetric[0] : undefined);
  }, [selectedMetric]);

  const { data } = useMetrics(id!, selectedMetric, hours, selectedInterface);

  const chartData = (data?.rows ?? []).map((p) => ({
    time: new Date(p.time).toLocaleString("tr-TR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }),
    value: Number(p.value.toFixed(2))
  }));

  return (
    <div>
      <Link to="/devices" className="flex items-center gap-1.5 text-sm text-text-secondary mb-3 w-fit">
        <ArrowLeft size={15} />
        Cihazlara dön
      </Link>
      <h1 className="text-lg font-medium mb-4">Cihaz detayı</h1>

      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex gap-2 flex-wrap">
          {uniqueMetricNames.map((m) => (
            <button
              key={m}
              onClick={() => setSelectedMetric(m)}
              className={`text-xs px-3 py-1.5 rounded-md border ${
                selectedMetric === m
                  ? "bg-[var(--bg-accent)] text-[var(--text-accent)] border-transparent font-medium"
                  : "border-border text-text-secondary"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        <div className="flex gap-1 bg-surface-1 rounded-md p-1 border border-border">
          {RANGE_OPTIONS.map((r) => (
            <button
              key={r.hours}
              onClick={() => setHours(r.hours)}
              className={`text-xs px-2.5 py-1 rounded ${
                hours === r.hours ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {interfacesForMetric.length > 0 && (
        <div className="flex gap-2 mb-3">
          {interfacesForMetric.map((iface) => (
            <button
              key={iface}
              onClick={() => setSelectedInterface(iface)}
              className={`text-xs px-2.5 py-1 rounded-md border ${
                selectedInterface === iface ? "border-[var(--text-accent)] text-[var(--text-accent)]" : "border-border text-text-secondary"
              }`}
            >
              {iface}
            </button>
          ))}
        </div>
      )}

      <div className="bg-surface-2 border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-medium">
            {selectedMetric || "Metrik seçin"}
            {selectedInterface && <span className="text-text-secondary font-normal"> · {selectedInterface}</span>}
          </p>
          {data?.source && <span className="text-xs text-text-muted">kaynak: {data.source}</span>}
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="time" tick={{ fontSize: 11, fill: "var(--text-secondary)" }} />
            <YAxis tick={{ fontSize: 12, fill: "var(--text-secondary)" }} />
            <Tooltip contentStyle={{ background: "var(--surface-1)", border: "1px solid var(--border)", fontSize: 13 }} />
            <Line type="monotone" dataKey="value" stroke="var(--text-accent)" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
        {chartData.length === 0 && <p className="text-sm text-text-muted py-8 text-center">Veri bulunamadı.</p>}
      </div>
    </div>
  );
}
