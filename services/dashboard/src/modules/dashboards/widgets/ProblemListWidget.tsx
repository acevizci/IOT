import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { apiFetch } from "../../../api/client";

interface Alert {
  id: string;
  metric_name: string;
  device_name?: string;
  severity: string;
  triggered_at: string;
}

export function ProblemListWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const limit = config.limit || 5;
  const groupQs = config.device_group_id ? `&device_group_id=${config.device_group_id}` : "";

  const { data, isLoading } = useQuery({
    queryKey: ["widget-problem-list", limit, config.device_group_id],
    queryFn: () => apiFetch<{ items: Alert[] }>(`/api/v1/alerts?status=open&limit=${limit}${groupQs}`),
    refetchInterval: 30000
  });

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary mb-2">{title || "Açık Alarmlar"}</p>
      {isLoading && <p className="text-xs text-text-muted">Yükleniyor...</p>}
      <div className="flex-1 overflow-y-auto flex flex-col gap-1.5">
        {data?.items?.map((a) => (
          <Link key={a.id} to={`/alerts/${a.id}`} className="flex items-center gap-1.5 text-xs hover:opacity-80">
            <AlertTriangle size={11} className="text-[var(--text-warning)] shrink-0" />
            <span className="truncate">{a.device_name || a.metric_name}</span>
          </Link>
        ))}
        {data?.items?.length === 0 && <p className="text-xs text-text-muted">Açık alarm yok.</p>}
      </div>
    </div>
  );
}
