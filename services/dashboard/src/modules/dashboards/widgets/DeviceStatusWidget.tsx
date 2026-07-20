import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../api/client";
import type { DashboardContext } from "../../../api/dashboards";
import { STATUS_TONES } from "../../../theme";

interface DeviceSummary {
  active: number;
  down: number;
  total: number;
}

// Faz 10.2 — mevcut "Cihaz Durumu" widget'ının render'ı, Zabbix'in "Host availability"
// panelindeki gibi büyük renkli bloklara çevrildi (Kullanılabilir/Kullanılamaz/Bilinmiyor/
// Toplam). Faz 9.5'teki Pano/Özel kaynak seçimi mantığı AYNEN korunuyor, sadece görsel
// değişti — yeni bir widget tipi eklenmedi, backend değişmedi.
export function DeviceStatusWidget({
  config,
  title,
  dashboardContext
}: {
  config: Record<string, any>;
  title?: string | null;
  dashboardContext?: DashboardContext;
}) {
  const usesDashboardSource = config.group_source === "dashboard";
  const groupId = usesDashboardSource ? dashboardContext?.deviceGroupId || undefined : config.device_group_id;

  const { data, isLoading } = useQuery({
    queryKey: ["widget-device-status", groupId],
    queryFn: async () => {
      if (groupId) {
        const group = await apiFetch<{ members: Array<{ status: string }> }>(`/api/v1/device-groups/${groupId}`);
        const active = group.members.filter((d) => d.status === "active").length;
        const down = group.members.filter((d) => d.status === "down").length;
        return { active, down, total: group.members.length } as DeviceSummary;
      }
      const result = await apiFetch<{ items: Array<{ status: string }> }>(`/api/v1/devices?limit=200`);
      const active = result.items.filter((d) => d.status === "active").length;
      const down = result.items.filter((d) => d.status === "down").length;
      return { active, down, total: result.items.length } as DeviceSummary;
    },
    refetchInterval: 30000
  });

  const unknown = Math.max((data?.total ?? 0) - (data?.active ?? 0) - (data?.down ?? 0), 0);

  const blocks = [
    { label: "Kullanılabilir", value: data?.active ?? 0, bg: STATUS_TONES.good.bg, text: STATUS_TONES.good.text },
    { label: "Kullanılamaz", value: data?.down ?? 0, bg: STATUS_TONES.crit.bg, text: STATUS_TONES.crit.text },
    { label: "Bilinmiyor", value: unknown, bg: STATUS_TONES.unknown.bg, text: STATUS_TONES.unknown.text },
    { label: "Toplam", value: data?.total ?? 0, bg: "var(--surface-1)", text: "var(--text-secondary)" }
  ];

  return (
    <div className="h-full flex flex-col">
      <p className="text-xs text-text-secondary mb-2">{title || "Cihaz Durumu"}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : (
        <div className="flex-1 grid grid-cols-4 gap-1.5">
          {blocks.map((b) => (
            <div key={b.label} className="flex flex-col items-center justify-center rounded-lg py-2 px-1" style={{ backgroundColor: b.bg }}>
              <span className="text-lg font-semibold" style={{ color: b.text }}>
                {b.value}
              </span>
              <span className="text-[9px] text-text-muted text-center leading-tight mt-0.5">{b.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
