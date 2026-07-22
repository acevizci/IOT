import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { TrendingUp } from "lucide-react";
import { fetchPredictiveForecast } from "../../../api/dashboards";
import { useDeviceGroup } from "../../deviceGroups/useDeviceGroups";
import { SEVERITY_LABEL, SEVERITY_STYLES } from "../../shared/severity";
import { resolveRefreshInterval } from "./refreshInterval";

function formatHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}dk`;
  if (hours < 48) return `${hours.toFixed(1)}sa`;
  return `${Math.round(hours / 24)}gün`;
}

// Kullanıcı önerisi: Tahminsel Analiz'in (predictiveAnalytics.ts) ürettiği
// is_predictive alarmlarını "eşiğe kalan süreye" göre en yakından en uzağa
// sıralı gösterir -- Zabbix/Datadog'un "capacity forecast" panelleriyle AYNI
// fikir. severity_distribution/problem_list gibi ANLIK durumu değil, "yakın
// gelecekte ne bozulacak" sorusunu cevaplar.
export function PredictiveForecastWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const { data: group } = useDeviceGroup(config.device_group_id || "");
  const scopeLabel = config.device_group_id ? (group?.name || "…") : "Tüm cihazlar";

  const { data, isLoading } = useQuery({
    queryKey: ["widget-predictive-forecast", config.device_group_id, config.limit],
    queryFn: () => fetchPredictiveForecast(config.device_group_id, config.limit || 10),
    refetchInterval: resolveRefreshInterval(config, 30000)
  });

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary">{title || "Kapasite Tahmini"}</p>
      <p className="text-[10px] text-text-muted mb-2 truncate">{scopeLabel}</p>
      <div className="flex-1 overflow-y-auto flex flex-col gap-1.5">
        {isLoading && <p className="text-xs text-text-muted">Yükleniyor...</p>}
        {data?.map((item) => (
          <Link
            key={item.id}
            to={`/alerts/${item.id}`}
            className="flex items-center gap-1.5 text-xs hover:opacity-80"
            title={item.message}
          >
            <TrendingUp size={11} className="text-text-accent shrink-0" />
            <span className={`text-[9px] px-1 py-0.5 rounded font-medium shrink-0 ${SEVERITY_STYLES[item.severity] ?? "bg-surface-1 text-text-secondary"}`}>
              {SEVERITY_LABEL[item.severity] ?? item.severity}
            </span>
            <span className="flex-1 min-w-0 truncate">{item.device_name} · {item.metric_name}</span>
            <span className="text-text-muted shrink-0 font-mono">{formatHours(item.predicted_hours_to_breach)}</span>
          </Link>
        ))}
        {!isLoading && data?.length === 0 && <p className="text-xs text-text-muted">Yaklaşan bir eşik ihlali yok.</p>}
      </div>
    </div>
  );
}
