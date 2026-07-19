import { useQuery } from "@tanstack/react-query";
import { fetchVMwareInstanceSummary } from "../../../api/dashboards";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

// FAZ J — vCenter/ESXi'nin datastore'larını doluluk yüzdesiyle gösterir (basit bar
// görünümü). Datastore metrikleri hâlâ vCenter/ESXi cihazının KENDİ device_id'sinde
// (paylaşımlı, tek bir host'a "ait" değil, host hiyerarşi düzeltmesi bunları taşımadı).
export function VMwareDatastoreWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const deviceId: string | undefined = config.device_id;
  const { data, isLoading } = useQuery({
    queryKey: ["widget-vmware-datastore", deviceId],
    queryFn: () => fetchVMwareInstanceSummary(deviceId!, ["vmware_datastore_used_percent", "vmware_datastore_free_bytes"]),
    enabled: !!deviceId,
    refetchInterval: 30000
  });

  if (!deviceId) {
    return <p className="text-xs text-text-muted p-2">Widget ayarlarında bir vCenter/ESXi cihazı seçilmemiş.</p>;
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary mb-2">{title || "Datastore Kullanımı"}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : (
        <div className="flex-1 overflow-auto flex flex-col gap-2.5">
          {data?.map((ds) => {
            const usedPercent = ds.values.vmware_datastore_used_percent ?? 0;
            const freeBytes = ds.values.vmware_datastore_free_bytes;
            const barColor = usedPercent >= 90 ? "bg-[var(--text-danger)]" : usedPercent >= 75 ? "bg-[var(--text-warning)]" : "bg-[var(--text-accent)]";
            return (
              <div key={ds.instance_label}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium truncate">{ds.instance_label}</span>
                  <span className="text-[11px] text-text-secondary shrink-0">
                    %{usedPercent.toFixed(0)} dolu{freeBytes !== undefined ? ` — ${formatBytes(freeBytes)} boş` : ""}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-surface-1 overflow-hidden">
                  <div className={`h-full ${barColor}`} style={{ width: `${Math.min(usedPercent, 100)}%` }} />
                </div>
              </div>
            );
          })}
          {data?.length === 0 && <p className="text-xs text-text-muted py-2">Datastore bulunamadı.</p>}
        </div>
      )}
    </div>
  );
}
