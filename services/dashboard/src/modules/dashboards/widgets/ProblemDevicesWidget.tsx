import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { fetchProblemDevices } from "../../../api/dashboards";

export function ProblemDevicesWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget-problem-devices", config.device_group_id, config.limit],
    queryFn: () => fetchProblemDevices(config.device_group_id, config.limit || 10),
    refetchInterval: 30000
  });

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary mb-2">{title || "Alarmlı Cihazlar"}</p>
      <div className="flex-1 overflow-y-auto flex flex-col gap-1.5">
        {isLoading && <p className="text-xs text-text-muted">Yükleniyor...</p>}
        {data?.map((d) => (
          <Link key={d.id} to={`/devices/${d.id}`} className="flex items-center gap-1.5 text-xs hover:opacity-80">
            <AlertTriangle size={11} className="text-[var(--text-warning)] shrink-0" />
            <span className="flex-1 truncate">{d.name}</span>
            <span className="text-text-muted">{d.alert_count}</span>
          </Link>
        ))}
        {data?.length === 0 && <p className="text-xs text-text-muted">Alarmlı cihaz yok.</p>}
      </div>
    </div>
  );
}
