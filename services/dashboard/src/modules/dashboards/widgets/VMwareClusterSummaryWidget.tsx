import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle } from "lucide-react";
import { fetchVMwareInstanceSummary } from "../../../api/dashboards";

// FAZ J — vCenter'ın cluster'larını (DRS/HA durumu) gösterir. Cluster metrikleri
// hâlâ vCenter cihazının KENDİ device_id'sinde (host hiyerarşi düzeltmesi bunları
// taşımadı -- cluster'lar zaten device_groups olarak temsil ediliyor, metrik olarak
// vCenter'da kalması yeterli).
export function VMwareClusterSummaryWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const deviceId: string | undefined = config.device_id;
  const { data, isLoading } = useQuery({
    queryKey: ["widget-vmware-cluster-summary", deviceId],
    queryFn: () => fetchVMwareInstanceSummary(deviceId!, ["vmware_cluster_drs_enabled", "vmware_cluster_ha_enabled"]),
    enabled: !!deviceId,
    refetchInterval: 30000
  });

  if (!deviceId) {
    return <p className="text-xs text-text-muted p-2">Widget ayarlarında bir vCenter cihazı seçilmemiş.</p>;
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary mb-2">{title || "Cluster Özeti"}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : (
        <div className="flex-1 overflow-auto flex flex-col gap-1.5">
          {data?.map((cluster) => (
            <div key={cluster.instance_label} className="flex items-center justify-between bg-surface-1 border border-border rounded-md px-2.5 py-2">
              <span className="text-xs font-medium truncate">{cluster.instance_label}</span>
              <div className="flex items-center gap-3 shrink-0">
                <span className="flex items-center gap-1 text-[11px] text-text-secondary">
                  {cluster.values.vmware_cluster_drs_enabled === 1 ? <CheckCircle2 size={13} className="text-[var(--text-success)]" /> : <XCircle size={13} className="text-text-muted" />}
                  DRS
                </span>
                <span className="flex items-center gap-1 text-[11px] text-text-secondary">
                  {cluster.values.vmware_cluster_ha_enabled === 1 ? <CheckCircle2 size={13} className="text-[var(--text-success)]" /> : <XCircle size={13} className="text-text-muted" />}
                  HA
                </span>
              </div>
            </div>
          ))}
          {data?.length === 0 && <p className="text-xs text-text-muted py-2">Cluster bulunamadı.</p>}
        </div>
      )}
    </div>
  );
}
