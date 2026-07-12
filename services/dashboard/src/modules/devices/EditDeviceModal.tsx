import { useState } from "react";
import { X } from "lucide-react";
import { useUpdateDevice } from "./useDevices";
import type { Device } from "../../api/devices";

export function EditDeviceModal({ device, onClose }: { device: Device; onClose: () => void }) {
  const [name, setName] = useState(device.name);
  const [vendor, setVendor] = useState(device.vendor ?? "");
  const [location, setLocation] = useState(device.location ?? "");
  const [tagsInput, setTagsInput] = useState((device.attributes?.tags ?? []).join(", "));
  const [monitoringType, setMonitoringType] = useState<"snmp" | "netflow_only">(
    device.attributes?.monitoring_type === "netflow_only" ? "netflow_only" : "snmp"
  );
  const updateDevice = useUpdateDevice();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const tags = tagsInput.split(",").map((t) => t.trim()).filter(Boolean);
    updateDevice.mutate(
      {
        id: device.id,
        input: {
          name, vendor: vendor || undefined, location: location || undefined, tags,
          attributes: { ...(device.attributes || {}), monitoring_type: monitoringType === "netflow_only" ? "netflow_only" : undefined }
        }
      },
      { onSuccess: onClose }
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <form onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()} className="bg-surface-2 border border-border rounded-xl p-5 w-96">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-medium">Cihazı düzenle</h2>
          <button type="button" onClick={onClose} className="text-text-muted"><X size={18} /></button>
        </div>

        {updateDevice.isError && <p className="text-sm text-[var(--text-danger)] mb-3">{(updateDevice.error as Error).message}</p>}

        <div className="flex flex-col gap-3">
          <FormField label="İsim">
            <input value={name} onChange={(e) => setName(e.target.value)} required className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
          </FormField>
          <FormField label="IP adresi (değiştirilemez)">
            <input value={device.ip_address} disabled className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-0 text-text-muted" />
          </FormField>
          <FormField label="Üretici">
            <input value={vendor} onChange={(e) => setVendor(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
          </FormField>
          <FormField label="Lokasyon">
            <input value={location} onChange={(e) => setLocation(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
          </FormField>
          <FormField label="Etiketler (virgülle ayır)">
            <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" placeholder="prod, kritik" />
          </FormField>
          <FormField label="İzleme yöntemi">
            <select value={monitoringType} onChange={(e) => setMonitoringType(e.target.value as "snmp" | "netflow_only")} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1">
              <option value="snmp">SNMP</option>
              <option value="netflow_only">SNMP dışı (NetFlow/agent)</option>
            </select>
          </FormField>
        </div>

        <button type="submit" disabled={updateDevice.isPending} className="w-full mt-4 py-2 text-sm rounded-md bg-[var(--text-accent)] text-white">
          {updateDevice.isPending ? "Kaydediliyor..." : "Kaydet"}
        </button>
      </form>
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-text-secondary mb-1 block">{label}</label>
      {children}
    </div>
  );
}
