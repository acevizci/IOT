import { useQuery } from "@tanstack/react-query";
import { fetchPlatformSummary } from "../../../api/dashboards";
import { resolveRefreshInterval } from "./refreshInterval";

// Faz 10.5 — düz 4-sayı grid'i yerine, Zabbix'in "System information" panelindeki gibi
// parametre/değer (+ opsiyonel detay) satırlarından oluşan bir liste.
export function PlatformSummaryWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget-platform-summary"],
    queryFn: fetchPlatformSummary,
    refetchInterval: resolveRefreshInterval(config, 60000)
  });

  const rows = [
    {
      label: "Cihaz sayısı",
      value: data?.device_count ?? "-",
      detail: data ? `${data.device_active} aktif / ${data.device_down} down` : undefined
    },
    { label: "Şablon sayısı", value: data?.template_count ?? "-" },
    {
      label: "Kural sayısı",
      value: data?.rule_count ?? "-",
      detail: data ? `${data.active_rule_count} aktif / ${data.inactive_rule_count} pasif` : undefined
    },
    { label: "Açık alarm", value: data?.open_alert_count ?? "-" },
    { label: "Aktif metrik türü", detail: "son 24 saat", value: data?.active_metric_count ?? "-" },
    { label: "Kullanıcı sayısı", value: data?.user_count ?? "-" },
    { label: "Saniyede gelen metrik", value: data?.metrics_per_second ?? "-" }
  ];

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary mb-2">{title || "Sistem Bilgisi"}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : (
        <div className="flex-1 overflow-y-auto flex flex-col">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-2 py-1.5 border-b border-border last:border-0 text-xs">
              <span className="text-text-secondary">{r.label}</span>
              <span className="flex items-center gap-1.5">
                <span className="font-medium">{r.value}</span>
                {r.detail && <span className="text-[10px] text-text-muted">({r.detail})</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
