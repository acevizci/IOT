import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { fetchTopN } from "../../../api/dashboards";
import { useDeviceGroup } from "../../deviceGroups/useDeviceGroups";
import { resolveRefreshInterval } from "./refreshInterval";

export function TopNWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const metricName = config.metric_name;
  const { data: group } = useDeviceGroup(config.device_group_id || "");
  const scopeLabel = config.device_group_id ? (group?.name || "…") : "Tüm cihazlar";
  const { data, isLoading } = useQuery({
    queryKey: ["widget-top-n", metricName, config.device_group_id, config.limit, config.order],
    queryFn: () => fetchTopN(metricName, config.device_group_id, config.limit || 5, config.order || "desc"),
    enabled: !!metricName,
    refetchInterval: resolveRefreshInterval(config, 30000)
  });

  if (!metricName) return <p className="text-xs text-text-muted p-2">Widget ayarlarında metrik seçilmemiş.</p>;

  const maxValue = Math.max(...(data?.map((d) => d.value) || [1]), 1);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary">{title || `Top ${config.limit || 5}: ${metricName}`}</p>
      <p className="text-[10px] text-text-muted mb-2 truncate">{scopeLabel}</p>
      <div className="flex-1 overflow-y-auto flex flex-col gap-2">
        {isLoading && <p className="text-xs text-text-muted">Yükleniyor...</p>}
        {data?.map((d) => (
          <div key={d.id}>
            <div className="flex items-center justify-between text-xs mb-0.5">
              <Link to={`/devices/${d.id}`} className="truncate hover:text-text-accent">{d.name}</Link>
              <span className="text-text-muted shrink-0 ml-2">{d.value.toFixed(1)}</span>
            </div>
            <div className="h-1.5 bg-surface-1 rounded-full overflow-hidden">
              <div className="h-full bg-[var(--text-accent)] rounded-full" style={{ width: `${(d.value / maxValue) * 100}%` }} />
            </div>
          </div>
        ))}
        {data?.length === 0 && <p className="text-xs text-text-muted">Veri yok.</p>}
      </div>
    </div>
  );
}
