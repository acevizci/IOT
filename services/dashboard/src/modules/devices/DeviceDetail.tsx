import { useState, useEffect, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { useMetricNames, useMetrics } from "./useMetrics";
import { useDevice, useLatestData } from "./useDevices";

const RANGE_OPTIONS = [
  { label: "1 saat", hours: 1 },
  { label: "6 saat", hours: 6 },
  { label: "24 saat", hours: 24 },
  { label: "7 gün", hours: 168 }
];

export function DeviceDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: device } = useDevice(id!);
  const [tab, setTab] = useState<"charts" | "latest">("charts");

  return (
    <div>
      <Link to="/devices" className="flex items-center gap-1.5 text-sm text-text-secondary mb-3 w-fit">
        <ArrowLeft size={15} />
        Cihazlara dön
      </Link>

      <div className="flex items-center justify-between mb-2">
        <h1 className="text-lg font-medium">{device?.name ?? "Cihaz detayı"}</h1>
      </div>

      {device && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <span className="text-xs text-text-secondary font-mono">{device.ip_address}</span>
          <span className="text-xs text-text-secondary">· {device.device_type}</span>
          {device.location && <span className="text-xs text-text-secondary">· {device.location}</span>}
          {(device.attributes?.tags ?? []).map((t) => (
            <span key={t} className="text-[11px] px-1.5 py-0.5 rounded bg-surface-1 text-text-secondary border border-border">{t}</span>
          ))}
        </div>
      )}

      <div className="flex gap-1 bg-surface-1 rounded-md p-1 border border-border w-fit mb-4">
        <button onClick={() => setTab("charts")} className={`text-xs px-3 py-1.5 rounded ${tab === "charts" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
          Grafikler
        </button>
        <button onClick={() => setTab("latest")} className={`text-xs px-3 py-1.5 rounded ${tab === "latest" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
          Güncel değerler
        </button>
      </div>

      {tab === "charts" ? <ChartsTab deviceId={id!} /> : <LatestDataTab deviceId={id!} />}
    </div>
  );
}

function ChartsTab({ deviceId }: { deviceId: string }) {
  const { data: metricEntries } = useMetricNames(deviceId);
  const [selectedMetric, setSelectedMetric] = useState<string>("");
  const [selectedInterface, setSelectedInterface] = useState<string | undefined>(undefined);
  const [hours, setHours] = useState(6);

  const uniqueMetricNames = useMemo(() => Array.from(new Set(metricEntries?.map((m) => m.metric_name) ?? [])), [metricEntries]);
  const interfacesForMetric = useMemo(
    () => metricEntries?.filter((m) => m.metric_name === selectedMetric && m.interface).map((m) => m.interface as string) ?? [],
    [metricEntries, selectedMetric]
  );

  useEffect(() => {
    if (uniqueMetricNames.length > 0 && !selectedMetric) setSelectedMetric(uniqueMetricNames[0]);
  }, [uniqueMetricNames]);

  useEffect(() => {
    setSelectedInterface(interfacesForMetric.length > 0 ? interfacesForMetric[0] : undefined);
  }, [selectedMetric]);

  const { data } = useMetrics(deviceId, selectedMetric, hours, selectedInterface);
  const chartData = (data?.rows ?? []).map((p) => ({
    time: new Date(p.time).toLocaleString("tr-TR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }),
    value: Number(p.value.toFixed(2))
  }));

  return (
    <div>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex gap-2 flex-wrap">
          {uniqueMetricNames.map((m) => (
            <button key={m} onClick={() => setSelectedMetric(m)} className={`text-xs px-3 py-1.5 rounded-md border ${selectedMetric === m ? "bg-[var(--bg-accent)] text-[var(--text-accent)] border-transparent font-medium" : "border-border text-text-secondary"}`}>
              {m}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-surface-1 rounded-md p-1 border border-border">
          {RANGE_OPTIONS.map((r) => (
            <button key={r.hours} onClick={() => setHours(r.hours)} className={`text-xs px-2.5 py-1 rounded ${hours === r.hours ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {interfacesForMetric.length > 0 && (
        <div className="flex gap-2 mb-3">
          {interfacesForMetric.map((iface) => (
            <button key={iface} onClick={() => setSelectedInterface(iface)} className={`text-xs px-2.5 py-1 rounded-md border ${selectedInterface === iface ? "border-[var(--text-accent)] text-[var(--text-accent)]" : "border-border text-text-secondary"}`}>
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

function LatestDataTab({ deviceId }: { deviceId: string }) {
  const { data: latestData, isLoading } = useLatestData(deviceId);

  return (
    <div className="bg-surface-2 border border-border rounded-xl overflow-hidden">
      {isLoading && <p className="text-sm text-text-secondary p-4">Yükleniyor...</p>}
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-surface-1 text-text-secondary text-left">
            <th className="p-3 font-medium">Metrik</th>
            <th className="p-3 font-medium">Interface</th>
            <th className="p-3 font-medium text-right">Değer</th>
            <th className="p-3 font-medium">Birim</th>
            <th className="p-3 font-medium">Zaman</th>
          </tr>
        </thead>
        <tbody>
          {latestData?.map((d, i) => (
            <tr key={i} className="border-t border-border">
              <td className="p-3 font-medium">{d.metric_name}</td>
              <td className="p-3 text-text-secondary">{d.interface ?? "-"}</td>
              <td className="p-3 text-right font-medium">{Number(d.value).toLocaleString("tr-TR", { maximumFractionDigits: 2 })}</td>
              <td className="p-3 text-text-secondary">{d.unit ?? "-"}</td>
              <td className="p-3 text-text-muted text-xs">{new Date(d.time).toLocaleString("tr-TR")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {latestData?.length === 0 && <p className="text-sm text-text-muted p-4">Son 1 saatte veri yok.</p>}
    </div>
  );
}
