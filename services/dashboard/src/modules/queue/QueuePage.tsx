import { useState } from "react";
import { Clock } from "lucide-react";
import { useQueueOverview, useQueueDetails } from "./useQueue";
import { useProxies } from "../proxy/useProxies";

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
  // Isı skalası temadan gelir (index.css --heat-*): düşük gecikme sakin
  // (adaçayı) → yüksek gecikme sıcak (kil).
  const heat = [
    "bg-surface-2 text-text-secondary",
    "bg-[var(--heat-1-bg)] text-[var(--heat-1-fg)]",
    "bg-[var(--heat-2-bg)] text-[var(--heat-2-fg)]",
    "bg-[var(--heat-3-bg)] text-[var(--heat-3-fg)]",
    "bg-[var(--heat-4-bg)] text-[var(--heat-4-fg)]",
    "bg-[var(--heat-5-bg)] text-[var(--heat-5-fg)]"
  ];
  return heat[bucketIndex] ?? heat[heat.length - 1];
}

function timeSince(dateStr: string | null): string {
  if (!dateStr) return "hiç";
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}sn önce`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}dk önce`;
  return `${Math.floor(seconds / 3600)}s önce`;
}

// Item-lag tablosundaki gibi ayrık bucket'lar YOK -- proxy'nin kuyruğu tek bir
// biriken sayı (bağlantı kesintisi sürdükçe büyür). Kaba bir eşik yeterli: proxy
// erişilemezse (heartbeat gelmiyor) her zaman kırmızı; erişilebilirken kuyruk
// limitin yarısını geçtiyse sarı (senkron başarısız olmaya başlamış olabilir).
function proxyQueueColor(pendingQueueSize: number, retentionLimit: number, status: string): string {
  if (status === "down") return "text-[var(--text-danger)]";
  if (pendingQueueSize === 0) return "text-text-muted";
  if (pendingQueueSize > retentionLimit * 0.5) return "text-[var(--text-warning)]";
  return "text-text-secondary";
}

export function QueuePage() {
  const { data: overview, isLoading } = useQueueOverview();
  const { data: proxies } = useProxies();
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
                {BUCKETS.map((b, i) => {
                  // b.key, QueueOverviewRow'un herhangi bir alanı olabildiği için
                  // TS değeri string|number görüyor; bucket'lar sayısal, Number ile daralt.
                  const v = Number(row[b.key]);
                  return (
                    <td key={b.key} className="p-1.5 text-right">
                      <button
                        onClick={() => v > 0 && setSelectedCollector(row.collector_type)}
                        disabled={v === 0}
                        className={`w-full px-2 py-1 rounded ${bucketColor(v, i)} ${v > 0 ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
                      >
                        {v}
                      </button>
                    </td>
                  );
                })}
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

      <div className="border border-border rounded-xl overflow-hidden bg-surface-2 mb-4">
        <div className="px-4 py-2.5 bg-surface-1 border-b border-border">
          <p className="text-sm font-medium">Proxy Kuyrukları</p>
          <p className="text-xs text-text-muted mt-0.5">
            Merkeze henüz iletilememiş, proxy'nin kendi yerel Postgres'inde bekleyen metrik sayısı.
            Proxy erişilebilirken sürekli büyüyorsa, merkeze senkronize olamıyor demektir.
          </p>
        </div>
        {proxies && proxies.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-secondary text-left border-b border-border">
                <th className="p-2.5 font-medium">Site</th>
                <th className="p-2.5 font-medium text-right">Bekleyen kuyruk</th>
                <th className="p-2.5 font-medium text-right">Bağlı cihaz</th>
                <th className="p-2.5 font-medium text-right">Son başarılı senkron</th>
              </tr>
            </thead>
            <tbody>
              {proxies.map((p) => (
                <tr key={p.id} className="border-b border-border last:border-0">
                  <td className="p-2.5 font-medium">{p.name}</td>
                  <td className={`p-2.5 text-right font-medium ${proxyQueueColor(p.pending_queue_size, p.queue_retention_limit, p.status)}`}>
                    {p.pending_queue_size}
                  </td>
                  <td className="p-2.5 text-right text-text-muted">{p.connected_device_count}</td>
                  <td className="p-2.5 text-right text-text-muted">{timeSince(p.last_successful_sync_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="p-4 text-sm text-text-muted">
            Henüz kayıtlı bir proxy yok — "Proxy Kurulumu" sayfasından bir tane kurabilirsin.
          </p>
        )}
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
