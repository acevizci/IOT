import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Clock } from "lucide-react";
import { fetchMaintenanceWindowsWidget } from "../../../api/dashboards";
import { resolveRefreshInterval } from "./refreshInterval";

export function MaintenanceWindowsWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget-maintenance-windows"],
    queryFn: fetchMaintenanceWindowsWidget,
    refetchInterval: resolveRefreshInterval(config, 60000)
  });

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary mb-2">{title || "Bakım Pencereleri"}</p>
      <div className="flex-1 overflow-y-auto flex flex-col gap-1.5">
        {isLoading && <p className="text-xs text-text-muted">Yükleniyor...</p>}
        {data?.map((w) => (
          <Link key={w.id} to={`/maintenance/${w.id}`} className="flex items-center gap-1.5 text-xs hover:opacity-80">
            <Clock size={11} className={w.is_active ? "text-[var(--text-warning)] shrink-0" : "text-text-muted shrink-0"} />
            <span className="flex-1 truncate">{w.name}</span>
            {w.is_active && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--bg-warning)] text-[var(--text-warning)]">aktif</span>}
          </Link>
        ))}
        {data?.length === 0 && <p className="text-xs text-text-muted">Bakım penceresi yok.</p>}
      </div>
    </div>
  );
}
