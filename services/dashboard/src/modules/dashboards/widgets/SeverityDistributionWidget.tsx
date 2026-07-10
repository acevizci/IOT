import { useQuery } from "@tanstack/react-query";
import { fetchSeverityDistribution } from "../../../api/dashboards";

const SEVERITY_COLORS: Record<string, string> = {
  info: "#6b7280", warning: "#f59e0b", average: "#f97316", high: "#ef4444", disaster: "#991b1b"
};
const SEVERITY_LABEL: Record<string, string> = {
  info: "Bilgi", warning: "Uyarı", average: "Orta", high: "Yüksek", disaster: "Felaket"
};

export function SeverityDistributionWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget-severity-dist", config.device_group_id],
    queryFn: () => fetchSeverityDistribution(config.device_group_id),
    refetchInterval: 30000
  });

  return (
    <div className="h-full flex flex-col">
      <p className="text-xs text-text-secondary mb-2">{title || "Severity Dağılımı"}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : (
        <div className="flex-1 flex flex-col gap-1.5 justify-center">
          {data?.map((d) => (
            <div key={d.severity} className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: SEVERITY_COLORS[d.severity] || "#888" }} />
              <span className="text-xs text-text-secondary flex-1">{SEVERITY_LABEL[d.severity] || d.severity}</span>
              <span className="text-sm font-medium">{d.count}</span>
            </div>
          ))}
          {(!data || data.length === 0) && <p className="text-xs text-text-muted text-center">Açık alarm yok.</p>}
        </div>
      )}
    </div>
  );
}
