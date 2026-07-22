import { useQuery } from "@tanstack/react-query";
import { fetchMetrics } from "../../../api/metrics";
import { useDevice } from "../../devices/useDevices";
import { resolveRefreshInterval } from "./refreshInterval";

export function GaugeWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const { device_id: deviceId, metric_name: metricName, min = 0, max = 100 } = config;
  const { data: device } = useDevice(deviceId);
  const { data, isLoading } = useQuery({
    queryKey: ["widget-gauge", deviceId, metricName],
    queryFn: () => fetchMetrics(deviceId, metricName, 1),
    enabled: !!deviceId && !!metricName,
    refetchInterval: resolveRefreshInterval(config, 30000)
  });

  if (!deviceId || !metricName) return <p className="text-xs text-text-muted p-2">Widget ayarlarında cihaz/metrik seçilmemiş.</p>;

  const rows = data?.rows || [];
  const value = rows.length > 0 ? rows[rows.length - 1].value : null;
  const pct = value != null ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
  const color = pct > 90 ? "var(--text-danger)" : pct > 70 ? "var(--text-warning)" : "var(--text-success)";

  return (
    <div className="h-full flex flex-col items-center justify-center">
      <p className="text-xs text-text-secondary">{title || metricName}</p>
      <p className="text-[10px] text-text-muted mb-2 truncate">{device?.name || deviceId}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : (
        <div className="relative w-24 h-24">
          <svg viewBox="0 0 100 100" className="-rotate-90 w-full h-full">
            <circle cx="50" cy="50" r="42" fill="none" stroke="var(--surface-1)" strokeWidth="10" />
            <circle cx="50" cy="50" r="42" fill="none" stroke={color} strokeWidth="10" strokeDasharray={`${pct * 2.64} 264`} strokeLinecap="round" />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-sm font-semibold">{value != null ? value.toFixed(1) : "-"}</span>
          </div>
        </div>
      )}
    </div>
  );
}
