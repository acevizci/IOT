import { useQuery } from "@tanstack/react-query";
import { fetchSeverityDistribution } from "../../../api/dashboards";
import { SEVERITY_COLORS, SEVERITY_TEXT_COLORS, SEVERITY_LABELS as SEVERITY_LABEL } from "../../../theme";
import { useDeviceGroup } from "../../deviceGroups/useDeviceGroups";
import { resolveRefreshInterval } from "./refreshInterval";
// En kritikten en az kritiğe — Zabbix'in "Problems by severity" sıralamasıyla tutarlı.
const SEVERITY_ORDER = ["disaster", "high", "average", "warning", "info"];

// Faz 10.1 — düz nokta+liste yerine, TÜM severity'leri her zaman (veri olmasa bile 0
// olarak) gösteren renkli kutucuk grid'i. Bu sayede grid her zaman aynı 5 hücreyle
// tutarlı görünür, sadece "verisi olan" severity'ler görünüp kaybolmaz.
export function SeverityDistributionWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  // GERÇEK EKSİKLİK: hangi host grubuna göre filtrelendiği (veya "tüm cihazlar"
  // olduğu) hiçbir yerde yazmıyordu.
  const { data: group } = useDeviceGroup(config.device_group_id || "");
  const scopeLabel = config.device_group_id ? (group?.name || "…") : "Tüm cihazlar";

  const { data, isLoading } = useQuery({
    queryKey: ["widget-severity-dist", config.device_group_id],
    queryFn: () => fetchSeverityDistribution(config.device_group_id),
    refetchInterval: resolveRefreshInterval(config, 30000)
  });

  const countBySeverity = new Map((data ?? []).map((d) => [d.severity, d.count]));

  return (
    <div className="h-full flex flex-col">
      <p className="text-xs text-text-secondary">{title || "Severity Dağılımı"}</p>
      <p className="text-[10px] text-text-muted mb-2 truncate">{scopeLabel}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : (
        <div className="flex-1 grid grid-cols-5 gap-1.5">
          {SEVERITY_ORDER.map((sev) => {
            const count = countBySeverity.get(sev) ?? 0;
            const color = SEVERITY_COLORS[sev];
            const textColor = SEVERITY_TEXT_COLORS[sev] ?? color;
            return (
              <div
                key={sev}
                className="flex flex-col items-center justify-center rounded-lg py-2 px-1"
                style={{ backgroundColor: count > 0 ? `${color}26` : "var(--surface-1)" }}
              >
                <span className="text-lg font-semibold" style={{ color: count > 0 ? textColor : "var(--text-muted)" }}>
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
