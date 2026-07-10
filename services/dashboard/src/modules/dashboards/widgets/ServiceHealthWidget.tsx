import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle } from "lucide-react";
import { fetchServiceHealth } from "../../../api/dashboards";

export function ServiceHealthWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const scenarioId = config.web_scenario_id;
  const { data, isLoading } = useQuery({
    queryKey: ["widget-service-health", scenarioId],
    queryFn: () => fetchServiceHealth(scenarioId),
    enabled: !!scenarioId,
    refetchInterval: 30000
  });

  if (!scenarioId) return <p className="text-xs text-text-muted p-2">Widget ayarlarında Web Senaryosu seçilmemiş.</p>;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary mb-2">{title || data?.scenario_name || "Servis Sağlığı"}</p>
      <div className="flex-1 overflow-y-auto flex flex-col gap-2">
        {isLoading && <p className="text-xs text-text-muted">Yükleniyor...</p>}
        {data?.steps.map((step) => (
          <div key={step.step_name} className="flex items-center gap-2 text-xs">
            {step.status === 1 ? (
              <CheckCircle2 size={13} className="text-[var(--text-success)] shrink-0" />
            ) : (
              <XCircle size={13} className="text-[var(--text-danger)] shrink-0" />
            )}
            <span className="flex-1 truncate">{step.step_name}</span>
            {step.latency_ms != null && <span className="text-text-muted shrink-0">{step.latency_ms.toFixed(0)}ms</span>}
          </div>
        ))}
        {data?.steps.length === 0 && <p className="text-xs text-text-muted">Adım verisi yok.</p>}
      </div>
    </div>
  );
}
