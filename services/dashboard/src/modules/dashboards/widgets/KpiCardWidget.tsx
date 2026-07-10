import { useKpiValue } from "../useDashboards";

const LABELS: Record<string, string> = {
  open_alerts: "Açık Alarmlar",
  active_devices: "Aktif Cihazlar",
  total_devices: "Toplam Cihaz"
};

export function KpiCardWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const source = config.source || "open_alerts";
  const { data, isLoading } = useKpiValue(source);

  return (
    <div className="h-full flex flex-col items-center justify-center">
      <p className="text-xs text-text-secondary mb-1">{title || LABELS[source] || source}</p>
      <p className="text-3xl font-semibold text-text-accent">
        {isLoading ? "..." : data?.value ?? "-"}
      </p>
    </div>
  );
}
