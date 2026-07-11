import { useQuery } from "@tanstack/react-query";
import { fetchRawTable } from "../../../api/dashboards";

export function RawTableWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const { device_id: deviceId, metric_name: metricName } = config;
  const { data, isLoading } = useQuery({
    queryKey: ["widget-raw-table", deviceId, metricName],
    queryFn: () => fetchRawTable(deviceId, metricName),
    enabled: !!deviceId && !!metricName,
    refetchInterval: 30000
  });

  if (!deviceId || !metricName) return <p className="text-xs text-text-muted p-2">Widget ayarlarında cihaz/metrik seçilmemiş.</p>;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary mb-2">{title || metricName}</p>
      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="text-xs text-text-muted">Yükleniyor...</p>}
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-muted text-left"><th className="pb-1">Satır</th><th className="pb-1 text-right">Değer</th></tr>
          </thead>
          <tbody>
            {data?.map((row) => (
              <tr key={row.interface} className="border-t border-border">
                <td className="py-1">{row.interface}</td>
                <td className="py-1 text-right font-mono">{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.length === 0 && <p className="text-xs text-text-muted">Veri yok.</p>}
      </div>
    </div>
  );
}
