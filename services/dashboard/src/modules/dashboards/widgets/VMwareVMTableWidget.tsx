import { useQuery } from "@tanstack/react-query";
import { CircleDot } from "lucide-react";
import { fetchVMwareVMTable } from "../../../api/dashboards";

// FAZ J — bir vCenter'ın TÜM VM'lerini (power state, CPU, RAM) tablo halinde gösterir.
// device_group_id KULLANIYOR (device_id DEĞİL) çünkü host hiyerarşi düzeltmesinden
// SONRA VM metrikleri artık vCenter'ın değil, ÇALIŞTIKLARI HOST'un device_id'sinde --
// "bu vCenter'ın tüm VM'leri" sorgusu, o vCenter'ın senkronize ettiği "Tüm Host'lar"
// device_group'undaki TÜM host cihazlarını kapsamalı. Widget ayarlarında kullanıcı
// bu grubu seçer (dashboard'daki mevcut device_group seçici deseniyle aynı).
export function VMwareVMTableWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const deviceGroupId: string | undefined = config.device_group_id;
  const { data, isLoading } = useQuery({
    queryKey: ["widget-vmware-vm-table", deviceGroupId],
    queryFn: () => fetchVMwareVMTable(deviceGroupId!, ["vmware_vm_power_state", "vmware_vm_cpu_count", "vmware_vm_memory_size_mib"]),
    enabled: !!deviceGroupId,
    refetchInterval: 30000
  });

  if (!deviceGroupId) {
    return <p className="text-xs text-text-muted p-2">Widget ayarlarında bir host grubu (örn. "&lt;vCenter&gt; - Tüm Host'lar") seçilmemiş.</p>;
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary mb-2">{title || "VM Kaynak Kullanımı"}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[9px] text-text-muted uppercase tracking-wide">
                <th className="text-left font-normal pb-1">VM</th>
                <th className="text-left font-normal pb-1 px-2">Host</th>
                <th className="text-left font-normal pb-1 px-2">Durum</th>
                <th className="text-right font-normal pb-1 px-2">CPU</th>
                <th className="text-right font-normal pb-1">RAM</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((vm) => (
                <tr key={`${vm.device_id}-${vm.instance_label}`} className="border-t border-border">
                  <td className="py-1.5 pr-2 truncate max-w-[120px] font-medium">{vm.instance_label}</td>
                  <td className="py-1.5 px-2 truncate max-w-[100px] text-text-muted">{vm.device_name}</td>
                  <td className="py-1.5 px-2">
                    <span className={`flex items-center gap-1 ${vm.values.vmware_vm_power_state === 1 ? "text-[var(--text-success)]" : "text-text-muted"}`}>
                      <CircleDot size={10} />
                      {vm.values.vmware_vm_power_state === 1 ? "Açık" : "Kapalı"}
                    </span>
                  </td>
                  <td className="py-1.5 px-2 text-right">{vm.values.vmware_vm_cpu_count ?? "-"}</td>
                  <td className="py-1.5 text-right">
                    {vm.values.vmware_vm_memory_size_mib !== undefined ? `${(vm.values.vmware_vm_memory_size_mib / 1024).toFixed(1)} GB` : "-"}
                  </td>
                </tr>
              ))}
              {data?.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-text-muted py-2">VM bulunamadı.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
