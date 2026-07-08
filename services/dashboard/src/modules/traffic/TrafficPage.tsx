import { useState } from "react";
import { ArrowRightLeft, Network, Activity } from "lucide-react";
import { useTopTalkers, useTrafficSummary, useProtocolBreakdown } from "./useTraffic";
import { formatBytes, protocolName } from "./format";

const RANGE_OPTIONS = [
  { label: "Son 1 saat", hours: 1 },
  { label: "Son 6 saat", hours: 6 },
  { label: "Son 24 saat", hours: 24 }
];

export function TrafficPage() {
  const [hours, setHours] = useState(1);
  const { data: summary } = useTrafficSummary(hours);
  const { data: topTalkers, isLoading } = useTopTalkers(hours);
  const { data: protocols } = useProtocolBreakdown(hours);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-lg font-medium">Trafik analizi</h1>
        <div className="flex gap-1 bg-surface-1 rounded-md p-1 border border-border">
          {RANGE_OPTIONS.map((r) => (
            <button
              key={r.hours}
              onClick={() => setHours(r.hours)}
              className={`text-xs px-2.5 py-1 rounded ${hours === r.hours ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-5">
        <KpiCard label="Toplam trafik" value={summary ? formatBytes(Number(summary.total_bytes)) : "-"} icon={<Activity size={16} />} />
        <KpiCard label="Toplam flow" value={summary ? Number(summary.flow_count).toLocaleString("tr-TR") : "-"} icon={<ArrowRightLeft size={16} />} />
        <KpiCard label="Benzersiz kaynak" value={summary ? String(summary.unique_sources) : "-"} icon={<Network size={16} />} />
        <KpiCard label="Benzersiz hedef" value={summary ? String(summary.unique_destinations) : "-"} icon={<Network size={16} />} />
      </div>

      <div className="grid grid-cols-[1.6fr_1fr] gap-4">
        <div className="bg-surface-2 border border-border rounded-xl">
          <p className="text-sm font-medium px-4 pt-3.5 pb-2">En çok trafik üreten IP çiftleri</p>
          {isLoading && <p className="text-sm text-text-secondary px-4 pb-4">Yükleniyor...</p>}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-secondary text-left border-t border-border">
                <th className="px-4 py-2 font-medium">Kaynak</th>
                <th className="px-4 py-2 font-medium">Hedef</th>
                <th className="px-4 py-2 font-medium text-right">Trafik</th>
                <th className="px-4 py-2 font-medium text-right">Flow</th>
              </tr>
            </thead>
            <tbody>
              {topTalkers?.map((t, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-4 py-2 font-mono text-xs">{t.src_ip}</td>
                  <td className="px-4 py-2 font-mono text-xs">{t.dst_ip}</td>
                  <td className="px-4 py-2 text-right font-medium">{formatBytes(Number(t.total_bytes))}</td>
                  <td className="px-4 py-2 text-right text-text-secondary">{t.flow_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {topTalkers?.length === 0 && <p className="text-sm text-text-muted px-4 py-6">Bu aralıkta trafik verisi yok.</p>}
        </div>

        <div className="bg-surface-2 border border-border rounded-xl">
          <p className="text-sm font-medium px-4 pt-3.5 pb-2">Port / protokol dağılımı</p>
          {protocols?.map((p, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-2 border-t border-border text-sm">
              <span className="font-mono text-xs text-text-secondary">
                :{p.dst_port} <span className="text-text-muted">({protocolName(p.protocol)})</span>
              </span>
              <span className="font-medium">{formatBytes(Number(p.total_bytes))}</span>
            </div>
          ))}
          {(!protocols || protocols.length === 0) && <p className="text-sm text-text-muted px-4 py-6">Veri yok.</p>}
        </div>
      </div>
    </div>
  );
}

function KpiCard({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="bg-surface-1 rounded-xl p-4 border border-border">
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[13px] text-text-secondary">{label}</span>
        <span className="text-text-muted">{icon}</span>
      </div>
      <p className="text-2xl font-medium">{value}</p>
    </div>
  );
}
