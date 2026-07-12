import { useQuery } from "@tanstack/react-query";
import { fetchWebMonitoringSummary } from "../../../api/dashboards";

// Faz 10.3 — Zabbix'in "Web monitoring" widget'ının karşılığı: TÜM web senaryolarının
// Ok/Failed/Unknown dökümü, tek tabloda. Tekil senaryo detayı için zaten var olan
// "Servis Sağlığı" (service_health) widget'ıyla tamamlayıcı — bu widget genel bakış,
// o widget derinlemesine tekil senaryo görünümü sağlıyor.
export function WebMonitoringSummaryWidget({ title }: { config: Record<string, any>; title?: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget-web-monitoring-summary"],
    queryFn: fetchWebMonitoringSummary,
    refetchInterval: 30000
  });

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary mb-2">{title || "Web İzleme"}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : (
        <div className="flex-1 overflow-y-auto flex flex-col">
          <div className="flex items-center gap-2 text-[9px] text-text-muted uppercase tracking-wide px-1 pb-1 border-b border-border">
            <span className="flex-1">Senaryo</span>
            <span className="w-8 text-right shrink-0">Ok</span>
            <span className="w-10 text-right shrink-0">Failed</span>
            <span className="w-14 text-right shrink-0">Bilinmiyor</span>
          </div>
          {data?.map((s) => (
            <div key={s.scenario_id} className="flex items-center gap-2 text-xs px-1 py-1.5 border-b border-border last:border-0">
              <span className="flex-1 truncate">{s.scenario_name}</span>
              <span className="w-8 text-right shrink-0 text-[var(--text-success)] font-medium">{s.ok_count}</span>
              <span className="w-10 text-right shrink-0 text-[var(--text-danger)] font-medium">{s.failed_count}</span>
              <span className="w-14 text-right shrink-0 text-text-muted">{s.unknown_count}</span>
            </div>
          ))}
          {data?.length === 0 && <p className="text-xs text-text-muted mt-2">Henüz web senaryosu tanımlanmadı.</p>}
        </div>
      )}
    </div>
  );
}
