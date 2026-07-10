import { useQuery } from "@tanstack/react-query";
import { fetchPlatformSummary } from "../../../api/dashboards";

export function PlatformSummaryWidget({ title }: { config: Record<string, any>; title?: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget-platform-summary"],
    queryFn: fetchPlatformSummary,
    refetchInterval: 60000
  });

  const items = [
    { label: "Cihaz", value: data?.device_count },
    { label: "Şablon", value: data?.template_count },
    { label: "Aktif Kural", value: data?.active_rule_count },
    { label: "Açık Alarm", value: data?.open_alert_count }
  ];

  return (
    <div className="h-full flex flex-col">
      <p className="text-xs text-text-secondary mb-2">{title || "Platform Özeti"}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : (
        <div className="flex-1 grid grid-cols-2 gap-3 items-center">
          {items.map((item) => (
            <div key={item.label} className="text-center">
              <p className="text-xl font-semibold">{item.value ?? "-"}</p>
              <p className="text-[10px] text-text-muted">{item.label}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
