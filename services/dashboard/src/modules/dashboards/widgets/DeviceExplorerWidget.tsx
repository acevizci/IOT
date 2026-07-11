import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Router } from "lucide-react";
import { apiFetch } from "../../../api/client";

interface DeviceRow { id: string; name: string; ip_address: string; status: string }

export function DeviceExplorerWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget-device-explorer", config.device_group_id],
    queryFn: () => apiFetch<{ items: DeviceRow[] }>(`/api/v1/devices?limit=100`),
    refetchInterval: 30000
  });

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary mb-2">{title || "Cihaz/Metrik Gezgini"}</p>
      <div className="flex-1 overflow-y-auto flex flex-col gap-1">
        {isLoading && <p className="text-xs text-text-muted">Yükleniyor...</p>}
        {data?.items?.map((d) => (
          <Link key={d.id} to={`/devices/${d.id}`} className="flex items-center gap-1.5 text-xs hover:opacity-80 py-0.5">
            <Router size={11} className="text-text-secondary shrink-0" />
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${d.status === "active" ? "bg-[var(--text-success)]" : "bg-[var(--text-danger)]"}`} />
            <span className="flex-1 truncate">{d.name}</span>
          </Link>
        ))}
        {data?.items?.length === 0 && <p className="text-xs text-text-muted">Cihaz yok.</p>}
      </div>
    </div>
  );
}
