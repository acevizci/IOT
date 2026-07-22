import { useQuery } from "@tanstack/react-query";
import { LineChart, Line, ResponsiveContainer } from "recharts";
import { fetchHostPerformanceTable } from "../../../api/dashboards";
import { resolveRefreshInterval } from "./refreshInterval";

const BAR_WIDTH_PX = 96;

// Kullanıcı isteği: Zabbix'in "Top hosts by CPU utilization" widget'ındaki
// yeşil-sarı-kırmızı gradyan bar. Dış konteyner dolu yüzdeye göre daralır, İÇ
// gradient HER ZAMAN tam bar genişliğine göre çizilir -- böylece dolu kısmın
// rengi "0-100 ölçeğinde NEREDE olduğunu" gösterir (örn. %99 dolu bar gradyanın
// en kırmızı ucunu, %20 dolu bar sadece yeşil ucunu gösterir).
function UtilizationBar({ percent }: { percent: number }) {
  const clamped = Math.min(Math.max(percent, 0), 100);
  return (
    <div className="relative h-3 rounded overflow-hidden bg-surface-1 shrink-0" style={{ width: BAR_WIDTH_PX }} title={`${percent.toFixed(1)}%`}>
      <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${clamped}%` }}>
        <div className="h-full" style={{ width: BAR_WIDTH_PX, background: "linear-gradient(to right, #3fb88a 0%, #e0a935 55%, #ea6b53 100%)" }} />
      </div>
    </div>
  );
}

function formatWindow(value: number | null | undefined): string {
  return value !== null && value !== undefined ? value.toFixed(1) : "-";
}

// Faz 10.7 — her satır bir cihaz, her sütun bir metrik, her hücrede mini
// sparkline (eksensiz, sadece eğri) + en son değer. Backend'de sert üst
// sınırlar var (25 cihaz, 5 metrik, 30 nokta) — bu widget potansiyel olarak N×M
// küçük sorgu çalıştırıyor, bilinçli olarak sınırlanmış.
// Kullanıcı isteği: ilk (ana) metrik artık Zabbix'in "Top hosts" widget'ındaki
// gibi gradyan bar + yüzde + 5dk/15dk/1sa ortalama sütunlarıyla gösteriliyor;
// varsa geri kalan metrikler eski sparkline+değer biçiminde devam ediyor.
export function HostPerformanceTableWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const metrics: string[] = Array.isArray(config.metrics) ? config.metrics : [];
  const primaryMetric = metrics[0];
  const secondaryMetrics = metrics.slice(1);
  const min = config.min ?? 0;
  const max = config.max ?? 100;

  const { data, isLoading } = useQuery({
    queryKey: ["widget-host-performance-table", config.device_group_id, metrics],
    queryFn: () => fetchHostPerformanceTable(metrics, config.device_group_id),
    enabled: metrics.length > 0,
    refetchInterval: resolveRefreshInterval(config, 30000)
  });

  if (metrics.length === 0) {
    return <p className="text-xs text-text-muted p-2">Widget ayarlarında en az bir metrik seçilmemiş.</p>;
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary mb-2">{title || "Host Performans Tablosu"}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[9px] text-text-muted uppercase tracking-wide">
                <th className="text-left font-normal pb-1">Cihaz</th>
                <th className="text-left font-normal pb-1 px-2">{primaryMetric}</th>
                <th className="text-right font-normal pb-1 px-2">5dk ort.</th>
                <th className="text-right font-normal pb-1 px-2">15dk ort.</th>
                <th className="text-right font-normal pb-1 px-2">1sa ort.</th>
                {secondaryMetrics.map((m) => (
                  <th key={m} className="text-left font-normal pb-1 px-2">{m}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.map((row) => {
                const latestValue = row.latest[primaryMetric];
                const percent = latestValue !== null && latestValue !== undefined ? ((latestValue - min) / (max - min)) * 100 : 0;
                return (
                  <tr key={row.device_id} className="border-t border-border">
                    <td className="py-1.5 pr-2 truncate max-w-[100px] font-medium">{row.device_name}</td>
                    <td className="py-1.5 px-2">
                      <div className="flex items-center gap-1.5">
                        <UtilizationBar percent={percent} />
                        <span className="text-[11px] text-text-secondary shrink-0 font-mono">
                          {latestValue !== null && latestValue !== undefined ? `${latestValue.toFixed(1)}%` : "-"}
                        </span>
                      </div>
                    </td>
                    <td className="py-1.5 px-2 text-right text-text-muted font-mono">{formatWindow(row.windows?.avg_5m)}</td>
                    <td className="py-1.5 px-2 text-right text-text-muted font-mono">{formatWindow(row.windows?.avg_15m)}</td>
                    <td className="py-1.5 px-2 text-right text-text-muted font-mono">{formatWindow(row.windows?.avg_1h)}</td>
                    {secondaryMetrics.map((m) => (
                      <td key={m} className="py-1.5 px-2">
                        <div className="flex items-center gap-1.5">
                          <div className="w-14 h-5 shrink-0">
                            <ResponsiveContainer width="100%" height="100%">
                              <LineChart data={row.series[m] || []}>
                                <Line type="monotone" dataKey="value" stroke="var(--text-accent)" strokeWidth={1.2} dot={false} isAnimationActive={false} />
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                          <span className="text-[11px] text-text-secondary shrink-0">
                            {row.latest[m] !== null && row.latest[m] !== undefined ? row.latest[m]!.toFixed(1) : "-"}
                          </span>
                        </div>
                      </td>
                    ))}
                  </tr>
                );
              })}
              {data?.length === 0 && (
                <tr>
                  <td colSpan={metrics.length + 4} className="text-text-muted py-2">
                    Cihaz bulunamadı.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
