import { useQuery } from "@tanstack/react-query";
import { Zap } from "lucide-react";
import { fetchEscalationHistory } from "../../../api/dashboards";
import { resolveRefreshInterval } from "./refreshInterval";

export function EscalationHistoryWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget-escalation-history", config.limit],
    queryFn: () => fetchEscalationHistory(config.limit || 10),
    refetchInterval: resolveRefreshInterval(config, 30000)
  });

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary mb-2">{title || "Eskalasyon Geçmişi"}</p>
      <div className="flex-1 overflow-y-auto flex flex-col gap-1.5">
        {isLoading && <p className="text-xs text-text-muted">Yükleniyor...</p>}
        {data?.map((e) => (
          <div key={e.id} className="flex items-center gap-1.5 text-xs">
            <Zap size={11} className="text-[var(--text-warning)] shrink-0" />
            <span className="flex-1 truncate">{e.device_name} · {e.metric_name}</span>
            <span className="text-text-muted shrink-0">adım {e.last_escalation_step}</span>
          </div>
        ))}
        {data?.length === 0 && <p className="text-xs text-text-muted">Eskalasyon geçmişi yok.</p>}
      </div>
    </div>
  );
}
