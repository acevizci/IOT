import { useQuery } from "@tanstack/react-query";
import { RadioTower } from "lucide-react";
import { fetchTrapLog } from "../../../api/dashboards";

// Kullanıcı isteği: SNMP Trap alıcısının (trapReceiver.ts) yayınladığı olayları
// zaman sırasıyla gösteren basit bir liste -- ayrı bir "trap log" görselleştirmesi,
// önceden bu veri sadece metrik grafiği/alarm geçmişinde dolaylı olarak görünüyordu.
export function TrapLogWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const deviceGroupId: string | undefined = config.device_group_id;
  const { data, isLoading } = useQuery({
    queryKey: ["widget-trap-log", deviceGroupId, config.limit],
    queryFn: () => fetchTrapLog(deviceGroupId, config.limit || 20),
    refetchInterval: 30000
  });

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary mb-2">{title || "SNMP Trap Günlüğü"}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : (
        <div className="flex-1 overflow-auto flex flex-col gap-1.5">
          {data?.map((trap, i) => (
            <div key={i} className="flex items-center gap-2 bg-surface-1 border border-border rounded-md px-2.5 py-1.5">
              <RadioTower size={13} className="text-text-accent shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{trap.trap_type}</p>
                <p className="text-[10px] text-text-muted truncate">{trap.device_name}</p>
              </div>
              <span className="text-[10px] text-text-muted shrink-0">{new Date(trap.time).toLocaleTimeString("tr-TR")}</span>
            </div>
          ))}
          {data?.length === 0 && <p className="text-xs text-text-muted py-2">Henüz trap alınmadı.</p>}
        </div>
      )}
    </div>
  );
}
