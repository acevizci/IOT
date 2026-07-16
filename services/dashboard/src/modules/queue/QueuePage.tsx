import { useState } from "react";
import { Clock } from "lucide-react";
import { useQueueOverview, useQueueDetails } from "./useQueue";

const COLLECTOR_LABELS: Record<string, string> = {
  snmp: "SNMP",
  http_json: "HTTP JSON",
  ssh_exec: "SSH",
  tcp_port: "TCP Port",
  icmp_ping: "ICMP Ping",
  sql_postgres: "SQL (PostgreSQL)",
  sql_mysql: "SQL (MySQL)",
  web_scenario: "Web Senaryosu",
  agent: "Agent"
};

const BUCKETS: { key: keyof import("../../api/queue").QueueOverviewRow; label: string }[] = [
  { key: "bucket_5s", label: "5sn" },
  { key: "bucket_10s", label: "10sn" },
  { key: "bucket_30s", label: "30sn" },
  { key: "bucket_1m", label: "1dk" },
  { key: "bucket_5m", label: "5dk" },
  { key: "bucket_over_5m", label: ">5dk" }
];

// Zabbix'in Queue overview tablosundaki gibi -- gecikme arttikça hucre daha
// "sicak" (kirmiziya yakin) bir renk alir, 0 ise notr/gri kalir.
function bucketColor(count: number, bucketIndex: number): string {
  if (count === 0) return "text-text-muted";
  const heat = ["bg-surface-2 text-text-secondary", "bg-blue-500/15 text-blue-300", "bg-yellow-500/15 text-yellow-300", "bg-orange-500/20 text-orange-300", "bg-orange-500/30 text-orange-300", "bg-red-500/25 text-red-300"];
  return heat[bucketIndex] ?? heat[heat.length - 1];
}

export function QueuePage() {
  const { data: overview, isLoading } = useQueueOverview();
  const [selectedCollector, setSelectedCollector] = useState<string | null>(null);
  const { data: details } = useQueueDetails(selectedCollector || undefined);

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <Clock size={18} />
        <h1 className="text-lg font-medium">Kuyruk (Queue)</h1>
      </div>
      <p className="text-sm text-text-secondary mb-4">
        Her collector tipinin toplama ile ne kadar geride kaldığını gösterir. Bir hücreye tıklayarak
        o tipteki gecikmiş kayıtların ayrıntısını görebilirsin.
      </p>

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden bg-surface-2 mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-1 text-text-secondary text-left border-b border-border">
              <th className="p-2.5 font-medium">Collector</th>
              <th className="p-2.5 font-medium text-right">Sağlıklı</th>
              {BUCKETS.map((b) => (
                <th key={b.key} className="p-2.5 font-medium text-right">{b.label}</th>
              ))}
              <th className="p-2.5 font-medium text-right">Toplam</th>
            </tr>
          </thead>
          <tbody>
            {overview?.map((row) => (
              <tr key={row.collector_type} className="border-b border-border last:border-0">
                <td className="p-2.5 font-medium">{COLLECTOR_LABELS[row.collector_type] ?? row.collector_type}</td>
                <td className="p-2.5 text-right text-text-muted">{row.not_due}</td>
                {BUCKETS.map((b, i) => (
                  <td key={b.key} className="p-1.5 text-right">
                    <button
                      onClick={() => row[b.key] > 0 && setSelectedCollector(row.collector_type)}
                      disabled={row[b.key] === 0}
                      className={`w-full px-2 py-1 rounded ${bucketColor(row[b.key], i)} ${row[b.key] > 0 ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
                    >
                      {row[b.key]}
                    </button>
                  </td>
                ))}
                <td className="p-2.5 text-right font-medium">{row.total}</td>
              </tr>
            ))}
            {overview?.length === 0 && (
              <tr>
                <td colSpan={9} className="p-4 text-center text-text-muted">Henüz zamanlanmış bir kayıt yok.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selectedCollector && (
        <div className="border border-border rounded-xl overflow-hidden bg-surface-2">
          <div className="flex items-center justify-between px-4 py-2.5 bg-surface-1 border-b border-border">
            <p className="text-sm font-medium">
              {COLLECTOR_LABELS[selectedCollector] ?? selectedCollector} — gecikmiş kayıtlar
            </p>
            <button onClick={() => setSelectedCollector(null)} className="text-xs text-text-muted hover:text-text-primary">
              Kapat
            </button>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-secondary text-left border-b border-border">
                <th className="p-2.5 font-medium">Cihaz</th>
                <th className="p-2.5 font-medium">Metrik / Senaryo</th>
                <th className="p-2.5 font-medium text-right">Gecikme</th>
                <th className="p-2.5 font-medium">Son hata</th>
              </tr>
            </thead>
            <tbody>
              {details?.map((d) => (
                <tr key={`${d.device_id}-${d.resource_id}`} className="border-b border-border last:border-0">
                  <td className="p-2.5">{d.device_name}</td>
                  <td className="p-2.5 text-text-secondary">{d.resource_name}</td>
                  <td className="p-2.5 text-right text-text-muted">{d.delay_seconds}sn</td>
                  <td className="p-2.5 text-[var(--text-danger)] text-xs">{d.last_error || ""}</td>
                </tr>
              ))}
              {details?.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-4 text-center text-text-muted">Gecikmiş kayıt yok.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
