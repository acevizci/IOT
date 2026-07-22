import { useQuery } from "@tanstack/react-query";
import { fetchStatusBadge } from "../../../api/dashboards";
import { useDevice } from "../../devices/useDevices";
import { resolveRefreshInterval } from "./refreshInterval";

const STATUS_COLORS: Record<string, string> = {
  up: "var(--text-success)", green: "var(--text-success)", available: "var(--text-success)",
  down: "var(--text-danger)", red: "var(--text-danger)", unavailable: "var(--text-danger)",
  yellow: "var(--text-warning)", warning: "var(--text-warning)"
};

export function StatusBadgeWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const { device_id: deviceId, metric_name: metricName } = config;
  // GERÇEK EKSİKLİK (kullanıcı bulundu): aynı panoda birden fazla durum rozeti
  // varsa (örn. 3 farklı cihazın "ping" durumu), hangisinin hangi cihaza ait
  // olduğunu ayırt etmenin HİÇBİR yolu yoktu -- başlık her zaman aynı ham
  // metrik adıydı, cihaz adı hiçbir yerde gösterilmiyordu.
  const { data: device } = useDevice(deviceId);
  const { data, isLoading } = useQuery({
    queryKey: ["widget-status-badge", deviceId, metricName],
    queryFn: () => fetchStatusBadge(deviceId, metricName),
    enabled: !!deviceId && !!metricName,
    refetchInterval: resolveRefreshInterval(config, 30000)
  });

  if (!deviceId || !metricName) return <p className="text-xs text-text-muted p-2">Widget ayarlarında cihaz/metrik seçilmemiş.</p>;

  const label = data?.label?.toLowerCase() || "";
  const color = STATUS_COLORS[label] || "var(--text-secondary)";

  return (
    <div className="h-full flex flex-col">
      <p className="text-xs text-text-secondary">{title || metricName}</p>
      <p className="text-[10px] text-text-muted mb-2 truncate">{device?.name || deviceId}</p>
      <div className="flex-1 flex items-center justify-center">
        {isLoading ? (
          <p className="text-xs text-text-muted">Yükleniyor...</p>
        ) : (
          <span className="text-sm font-medium px-4 py-2 rounded-full" style={{ backgroundColor: `${color}22`, color }}>
            {data?.label || "Veri yok"}
          </span>
        )}
      </div>
    </div>
  );
}
