import { useState, useEffect } from "react";
import { X, Plus, Trash2 } from "lucide-react";
import { useUpdateDevice, useDeviceInterfaces, useSaveDeviceInterfaces } from "./useDevices";
import { useProxies } from "../proxy/useProxies";
import type { Device, DeviceInterfaceInput } from "../../api/devices";

const INTERFACE_TYPE_LABEL: Record<string, string> = { snmp: "SNMP", ssh: "SSH", sql: "SQL", web: "Web", vmware: "VMware" };

export function EditDeviceModal({ device, onClose }: { device: Device; onClose: () => void }) {
  const [name, setName] = useState(device.name);
  const [vendor, setVendor] = useState(device.vendor ?? "");
  const [location, setLocation] = useState(device.location ?? "");
  const [latitude, setLatitude] = useState(device.latitude != null ? String(device.latitude) : "");
  const [longitude, setLongitude] = useState(device.longitude != null ? String(device.longitude) : "");
  const [tagsInput, setTagsInput] = useState((device.attributes?.tags ?? []).join(", "));
  const [interfaces, setInterfaces] = useState<DeviceInterfaceInput[]>([]);
  const [assignedProxyId, setAssignedProxyId] = useState(device.assigned_proxy_id ?? "");

  const { data: existingInterfaces } = useDeviceInterfaces(device.id);
  const { data: proxies } = useProxies();
  const updateDevice = useUpdateDevice();
  const saveInterfaces = useSaveDeviceInterfaces(device.id);

  useEffect(() => {
    if (existingInterfaces) {
      setInterfaces(existingInterfaces.map((i) => ({
        interface_type: i.interface_type, ip_address: i.ip_address || "", port: i.port || undefined, snmp_community: i.snmp_community || "",
        vmware_mode: i.vmware_mode || undefined, tls_skip_verify: i.tls_skip_verify
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
      {
        id: device.id,
        input: {
          name,
          vendor: vendor || undefined,
          location: location || undefined,
          latitude: latitude ? Number(latitude) : undefined,
          longitude: longitude ? Number(longitude) : undefined,
          tags,
          // Monitoring Proxy: boş seçenek = doğrudan core'a bağlan (null gönderilir,
          // undefined DEĞİL -- aksi halde mevcut atama dokunulmadan kalır, ayrılmaz).
          assigned_proxy_id: assignedProxyId || null
        }
      },
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
            {interfaces.some((i) => i.interface_type === "vmware") && (
              <p className="text-[11px] text-text-muted mb-1.5">
                VMware kullanıcı adı/şifresi burada girilmez — <a href="/macros" className="text-text-accent underline">Makrolar</a> sayfasında
                {" "}<code className="font-mono">{"{$VMWARE_USER}"}</code> ve <code className="font-mono">{"{$VMWARE_PASSWORD}"}</code> tanımlanmalı.
              </p>
            )}
            <div className="flex flex-col gap-2">
              {interfaces.map((iface, i) => (
                <div key={i} className="bg-surface-1 border border-border rounded-md p-2 flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <select value={iface.interface_type} onChange={(e) => updateInterface(i, { interface_type: e.target.value as any })} className="text-xs px-2 py-1 rounded border border-border bg-surface-0 w-20">
                      {Object.entries(INTERFACE_TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                    <input value={iface.ip_address || ""} onChange={(e) => updateInterface(i, { ip_address: e.target.value })} placeholder="IP adresi" className="flex-1 text-xs px-2 py-1 rounded border border-border bg-surface-0" />
                    {iface.interface_type === "snmp" && (
                      <input value={iface.snmp_community || ""} onChange={(e) => updateInterface(i, { snmp_community: e.target.value })} placeholder="community" className="w-20 text-xs px-2 py-1 rounded border border-border bg-surface-0" />
                    )}
                    {iface.interface_type === "vmware" && (
                      <>
                        <select value={iface.vmware_mode || "vcenter"} onChange={(e) => updateInterface(i, { vmware_mode: e.target.value as any })} className="text-xs px-2 py-1 rounded border border-border bg-surface-0 w-24">
                          <option value="vcenter">vCenter</option>
                          <option value="esxi">ESXi (bağımsız)</option>
                        </select>
                        <input type="number" value={iface.port ?? 443} onChange={(e) => updateInterface(i, { port: Number(e.target.value) })} placeholder="port" className="w-16 text-xs px-2 py-1 rounded border border-border bg-surface-0" />
                      </>
                    )}
                    <button type="button" onClick={() => removeInterface(i)} className="shrink-0 text-text-muted hover:text-[var(--text-danger)]">
                      <Trash2 size={13} />
                    </button>
                  </div>
                  {iface.interface_type === "vmware" && (
                    <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
                      <input type="checkbox" checked={iface.tls_skip_verify ?? false} onChange={(e) => updateInterface(i, { tls_skip_verify: e.target.checked })} />
                      Sertifika doğrulamayı atla (self-signed lab ortamları için)
                    </label>
                  )}
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
          <div className="flex gap-2">
            <FormField label="Enlem (opsiyonel)">
              <input type="number" step="any" min={-90} max={90} value={latitude} onChange={(e) => setLatitude(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" placeholder="41.0082" />
            </FormField>
            <FormField label="Boylam (opsiyonel)">
              <input type="number" step="any" min={-180} max={180} value={longitude} onChange={(e) => setLongitude(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" placeholder="28.9784" />
            </FormField>
          </div>
          <FormField label="Etiketler (virgülle ayır)">
            <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" placeholder="prod, kritik" />
          </FormField>
          <FormField label="Proxy (agent bu cihazdaysa)">
            <select value={assignedProxyId} onChange={(e) => setAssignedProxyId(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1">
              <option value="">Doğrudan (proxy yok)</option>
              {proxies?.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <p className="text-[11px] text-text-muted mt-1">
              Seçilirse, cihazdaki agent bir sonraki heartbeat'inde otomatik olarak bu proxy'ye yönlendirilir.
            </p>
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
