import { useState, useEffect } from "react";
import { X, Plus, Trash2 } from "lucide-react";
import { useUpdateDevice, useDeviceInterfaces, useSaveDeviceInterfaces } from "./useDevices";
import type { Device, DeviceInterfaceInput } from "../../api/devices";

const INTERFACE_TYPE_LABEL: Record<string, string> = { snmp: "SNMP", ssh: "SSH", sql: "SQL", web: "Web" };

export function EditDeviceModal({ device, onClose }: { device: Device; onClose: () => void }) {
  const [name, setName] = useState(device.name);
  const [vendor, setVendor] = useState(device.vendor ?? "");
  const [location, setLocation] = useState(device.location ?? "");
  const [tagsInput, setTagsInput] = useState((device.attributes?.tags ?? []).join(", "));
  const [interfaces, setInterfaces] = useState<DeviceInterfaceInput[]>([]);

  const { data: existingInterfaces } = useDeviceInterfaces(device.id);
  const updateDevice = useUpdateDevice();
  const saveInterfaces = useSaveDeviceInterfaces(device.id);

  useEffect(() => {
    if (existingInterfaces) {
      setInterfaces(existingInterfaces.map((i) => ({
        interface_type: i.interface_type, ip_address: i.ip_address || "", port: i.port || undefined, snmp_community: i.snmp_community || ""
      })));
    }
  }, [existingInterfaces]);

  function addInterface() {
    setInterfaces((prev) => [...prev, { interface_type: "snmp", ip_address: "", snmp_community: "public" }]);
  }
  function updateInterface(i: number, patch: Partial<DeviceInterfaceInput>) {
    setInterfaces((prev) => prev.map((iface, idx) => (idx === i ? { ...iface, ...patch } : iface)));
  }
  function removeInterface(i: number) {
    setInterfaces((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const tags = tagsInput.split(",").map((t) => t.trim()).filter(Boolean);
    await saveInterfaces.mutateAsync(interfaces.filter((i) => i.ip_address));
    updateDevice.mutate(
      { id: device.id, input: { name, vendor: vendor || undefined, location: location || undefined, tags } },
      { onSuccess: onClose }
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <form onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()} className="bg-surface-2 border border-border rounded-xl p-5 w-[440px] max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-medium">Cihazı düzenle</h2>
          <button type="button" onClick={onClose} className="text-text-muted"><X size={18} /></button>
        </div>

        {(updateDevice.isError || saveInterfaces.isError) && (
          <p className="text-sm text-[var(--text-danger)] mb-3">
            {((updateDevice.error || saveInterfaces.error) as Error).message}
          </p>
        )}

        <div className="flex flex-col gap-3">
          <FormField label="İsim">
            <input value={name} onChange={(e) => setName(e.target.value)} required className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
          </FormField>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs text-text-secondary">Interface'ler</label>
              <button type="button" onClick={addInterface} className="flex items-center gap-1 text-xs text-text-accent">
                <Plus size={13} />
                Interface ekle
              </button>
            </div>
            {interfaces.length === 0 && <p className="text-[11px] text-text-muted">Hiç interface tanımlı değil.</p>}
            <div className="flex flex-col gap-2">
              {interfaces.map((iface, i) => (
                <div key={i} className="bg-surface-1 border border-border rounded-md p-2 flex items-center gap-1.5">
                  <select value={iface.interface_type} onChange={(e) => updateInterface(i, { interface_type: e.target.value as any })} className="text-xs px-2 py-1 rounded border border-border bg-surface-0 w-20">
                    {Object.entries(INTERFACE_TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  <input value={iface.ip_address || ""} onChange={(e) => updateInterface(i, { ip_address: e.target.value })} placeholder="IP adresi" className="flex-1 text-xs px-2 py-1 rounded border border-border bg-surface-0" />
                  {iface.interface_type === "snmp" && (
                    <input value={iface.snmp_community || ""} onChange={(e) => updateInterface(i, { snmp_community: e.target.value })} placeholder="community" className="w-20 text-xs px-2 py-1 rounded border border-border bg-surface-0" />
                  )}
                  <button type="button" onClick={() => removeInterface(i)} className="shrink-0 text-text-muted hover:text-[var(--text-danger)]">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <FormField label="Üretici">
            <input value={vendor} onChange={(e) => setVendor(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
          </FormField>
          <FormField label="Lokasyon">
            <input value={location} onChange={(e) => setLocation(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
          </FormField>
          <FormField label="Etiketler (virgülle ayır)">
            <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" placeholder="prod, kritik" />
          </FormField>
        </div>

        <button type="submit" disabled={updateDevice.isPending || saveInterfaces.isPending} className="w-full mt-4 py-2 text-sm rounded-md bg-[var(--text-accent)] text-white">
          {updateDevice.isPending || saveInterfaces.isPending ? "Kaydediliyor..." : "Kaydet"}
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
