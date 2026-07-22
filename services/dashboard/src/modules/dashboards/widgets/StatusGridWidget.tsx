import { useQuery } from "@tanstack/react-query";
import { fetchStatusGrid } from "../../../api/dashboards";
import { useValueMaps } from "../../valueMaps/useValueMaps";
import { TIMELINE_COLORS } from "./GraphWidget";
import { STATUS_TONES } from "../../../theme";
import { resolveRefreshInterval } from "./refreshInterval";

// Faz 10.6 — bir metriği TÜM cihazlarda tek bakışta gösteren genel amaçlı ızgara.
// Renklendirme iki moddan biriyle yapılır: value_map_id verilmişse etiket bazlı sabit
// palet (GraphWidget'ın StatusTimeline'ındaki mantıkla aynı fikir), yoksa good_max/
// critical_min eşiğine göre basit yeşil/turuncu/kırmızı 3 renkli eşikleme.
export function StatusGridWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const metricName = config.metric_name;
  const { data, isLoading } = useQuery({
    queryKey: ["widget-status-grid", metricName, config.device_group_id],
    queryFn: () => fetchStatusGrid(metricName, config.device_group_id),
    enabled: !!metricName,
    refetchInterval: resolveRefreshInterval(config, 30000)
  });
  const { data: valueMaps } = useValueMaps();
  const valueMap = config.value_map_id ? valueMaps?.find((vm) => vm.id === config.value_map_id) : undefined;

  if (!metricName) {
    return <p className="text-xs text-text-muted p-2">Widget ayarlarında metrik adı seçilmemiş.</p>;
  }

  function colorFor(value: number): { bg: string; text: string; label: string } {
    if (valueMap) {
      const mapping = valueMap.mappings.find((m) => Number(m.value) === value);
      const label = mapping?.label ?? String(value);
      const idx = valueMap.mappings.findIndex((m) => m.label === label);
      const color = TIMELINE_COLORS[Math.max(idx, 0) % TIMELINE_COLORS.length];
      return { bg: `${color}26`, text: color, label };
    }
    const goodMax = config.good_max;
    const criticalMin = config.critical_min;
    if (typeof goodMax === "number" && value <= goodMax) {
      return { bg: STATUS_TONES.good.bg, text: STATUS_TONES.good.text, label: String(value) };
    }
    if (typeof criticalMin === "number" && value >= criticalMin) {
      return { bg: STATUS_TONES.crit.bg, text: STATUS_TONES.crit.text, label: String(value) };
    }
    if (typeof goodMax === "number" || typeof criticalMin === "number") {
      return { bg: STATUS_TONES.warn.bg, text: STATUS_TONES.warn.text, label: String(value) };
    }
    return { bg: "var(--surface-1)", text: "var(--text-secondary)", label: String(value) };
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary mb-2">{title || "Durum Izgarası"}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : (
        <div className="flex-1 overflow-y-auto grid grid-cols-3 gap-1.5 content-start">
          {data?.map((d) => {
            const c = colorFor(d.value);
            return (
              <div
                key={d.id}
                className="flex flex-col items-center justify-center rounded-lg py-2 px-1"
                style={{ backgroundColor: c.bg }}
                title={d.name}
              >
                <span className="text-[10px] font-medium truncate w-full text-center" style={{ color: c.text }}>
                  {c.label}
                </span>
                <span className="text-[9px] text-text-muted truncate w-full text-center">{d.name}</span>
              </div>
            );
          })}
          {data?.length === 0 && <p className="text-xs text-text-muted col-span-3">Veri yok.</p>}
        </div>
      )}
    </div>
  );
}
