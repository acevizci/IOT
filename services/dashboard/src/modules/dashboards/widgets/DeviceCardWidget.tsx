import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { fetchDeviceCard } from "../../../api/dashboards";
import { resolveRefreshInterval } from "./refreshInterval";

export function DeviceCardWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const deviceId = config.device_id;
  const { data, isLoading } = useQuery({
    queryKey: ["widget-device-card", deviceId],
    queryFn: () => fetchDeviceCard(deviceId),
    enabled: !!deviceId,
    refetchInterval: resolveRefreshInterval(config, 30000)
  });

  if (!deviceId) return <p className="text-xs text-text-muted p-2">Widget ayarlarında cihaz seçilmemiş.</p>;
  if (isLoading) return <p className="text-xs text-text-muted p-2">Yükleniyor...</p>;
  if (!data) return <p className="text-xs text-text-muted p-2">Cihaz bulunamadı.</p>;

  return (
    <div className="h-full flex flex-col">
      <p className="text-xs text-text-secondary mb-2">{title || "Cihaz Kartı"}</p>
      <Link to={`/devices/${data.id}`} className="flex-1 flex flex-col justify-center">
        <div className="flex items-center gap-1.5 mb-1">
          <span className={`w-2 h-2 rounded-full ${data.status === "active" ? "bg-[var(--text-success)]" : "bg-[var(--text-danger)]"}`} />
          <p className="text-sm font-medium">{data.name}</p>
        </div>
        <p className="text-xs text-text-muted font-mono mb-2">{data.ip_address}</p>
        <div className="flex gap-3 text-xs">
          <span className="text-text-secondary">{data.device_type}</span>
          {data.open_alert_count > 0 && <span className="text-[var(--text-danger)]">{data.open_alert_count} alarm</span>}
        </div>
      </Link>
    </div>
  );
}
