import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../api/client";

interface DeviceSummary {
  active: number;
  down: number;
  total: number;
}

export function DeviceStatusWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ["widget-device-status", config.device_group_id],
    queryFn: async () => {
      // Faz 9.7 düzeltmesi: device_group_id filtresi daha önce hiç uygulanmıyordu (iki dal
      // da aynı sorguyu çalıştırıyordu) — artık gerçekten o gruba özel üyeleri çekiyor.
      if (config.device_group_id) {
        const group = await apiFetch<{ members: Array<{ status: string }> }>(`/api/v1/device-groups/${config.device_group_id}`);
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
