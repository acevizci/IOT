import { useQuery } from "@tanstack/react-query";
import { LineChart, Line, ResponsiveContainer } from "recharts";
import { fetchHostPerformanceTable } from "../../../api/dashboards";

// Faz 10.7 — en karmaşık widget: her satır bir cihaz, her sütun bir metrik, her
// hücrede mini sparkline (eksensiz, sadece eğri) + en son değer. Backend'de sert üst
// sınırlar var (25 cihaz, 5 metrik, 30 nokta) — bu widget potansiyel olarak N×M küçük
// sorgu çalıştırıyor, bilinçli olarak sınırlanmış.
export function HostPerformanceTableWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const metrics: string[] = Array.isArray(config.metrics) ? config.metrics : [];
  const { data, isLoading } = useQuery({
    queryKey: ["widget-host-performance-table", config.device_group_id, metrics],
    queryFn: () => fetchHostPerformanceTable(metrics, config.device_group_id),
    enabled: metrics.length > 0,
    refetchInterval: 30000
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
                {metrics.map((m) => (
                  <th key={m} className="text-left font-normal pb-1 px-2">{m}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.map((row) => (
                <tr key={row.device_id} className="border-t border-border">
                  <td className="py-1.5 pr-2 truncate max-w-[100px] font-medium">{row.device_name}</td>
                  {metrics.map((m) => (
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
              ))}
              {data?.length === 0 && (
                <tr>
                  <td colSpan={metrics.length + 1} className="text-text-muted py-2">
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
