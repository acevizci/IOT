import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../api/client";
import type { DashboardContext } from "../../../api/dashboards";

interface DeviceSummary {
  active: number;
  down: number;
  total: number;
}

// Faz 9.5 -- "Cihaz grubu kaynağı: Pano" seçilmişse, kendi config'indeki device_group_id
// yerine panonun üst bağlam seçicisindeki grubu kullanır.
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

  return (
    <div className="h-full flex flex-col items-center justify-center">
      <p className="text-xs text-text-secondary mb-2">{title || "Cihaz Durumu"}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : (
        <div className="flex gap-4">
          <div className="text-center">
            <p className="text-xl font-semibold text-[var(--text-success)]">{data?.active ?? 0}</p>
            <p className="text-[10px] text-text-muted">Aktif</p>
          </div>
          <div className="text-center">
            <p className="text-xl font-semibold text-[var(--text-danger)]">{data?.down ?? 0}</p>
            <p className="text-[10px] text-text-muted">Down</p>
          </div>
          <div className="text-center">
            <p className="text-xl font-semibold text-text-secondary">{data?.total ?? 0}</p>
            <p className="text-[10px] text-text-muted">Toplam</p>
          </div>
        </div>
      )}
    </div>
  );
}
