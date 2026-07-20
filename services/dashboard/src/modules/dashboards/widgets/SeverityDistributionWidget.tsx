import { useQuery } from "@tanstack/react-query";
import { fetchSeverityDistribution } from "../../../api/dashboards";
import { SEVERITY_COLORS, SEVERITY_LABELS as SEVERITY_LABEL } from "../../../theme";
// En kritikten en az kritiğe — Zabbix'in "Problems by severity" sıralamasıyla tutarlı.
const SEVERITY_ORDER = ["disaster", "high", "average", "warning", "info"];

// Faz 10.1 — düz nokta+liste yerine, TÜM severity'leri her zaman (veri olmasa bile 0
// olarak) gösteren renkli kutucuk grid'i. Bu sayede grid her zaman aynı 5 hücreyle
// tutarlı görünür, sadece "verisi olan" severity'ler görünüp kaybolmaz.
export function SeverityDistributionWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget-severity-dist", config.device_group_id],
    queryFn: () => fetchSeverityDistribution(config.device_group_id),
    refetchInterval: 30000
  });

  const countBySeverity = new Map((data ?? []).map((d) => [d.severity, d.count]));

  return (
    <div className="h-full flex flex-col">
      <p className="text-xs text-text-secondary mb-2">{title || "Severity Dağılımı"}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : (
        <div className="flex-1 grid grid-cols-5 gap-1.5">
          {SEVERITY_ORDER.map((sev) => {
            const count = countBySeverity.get(sev) ?? 0;
            const color = SEVERITY_COLORS[sev];
            return (
              <div
                key={sev}
                className="flex flex-col items-center justify-center rounded-lg py-2 px-1"
                style={{ backgroundColor: count > 0 ? `${color}26` : "var(--surface-1)" }}
              >
                <span className="text-lg font-semibold" style={{ color: count > 0 ? color : "var(--text-muted)" }}>
                  {count}
                </span>
                <span className="text-[9px] text-text-muted text-center leading-tight mt-0.5">{SEVERITY_LABEL[sev]}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
