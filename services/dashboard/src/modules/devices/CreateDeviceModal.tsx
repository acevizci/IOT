import { useState } from "react";
import { X, Radar, CircleCheck, CircleX, Plus, Trash2 } from "lucide-react";
import { useCreateDevice } from "./useDevices";
import { useDeviceGroups } from "../deviceGroups/useDeviceGroups";
import { discoverDevice } from "../../api/discovery";
import { assignDeviceToGroup } from "../../api/devices";
import type { DiscoveryResult } from "../../api/discovery";
import type { DeviceInterfaceInput } from "../../api/devices";

const DEVICE_TYPES = ["switch", "firewall", "server", "load_balancer", "router"];
const INTERFACE_TYPE_LABEL: Record<string, string> = { snmp: "SNMP", ssh: "SSH", sql: "SQL", web: "Web", vmware: "VMware" };

// Zabbix'in "New host" formuyla aynı sıra: İsim + Host Grupları ilk ve zorunlu,
// Interface'ler (varsa) ayrı, opsiyonel, çoklu bir liste — SNMP zorunlu, üst-seviye
// bir alan DEĞİL, sadece "interface ekle" ile seçilebilen bir tiplerden biri.
export function CreateDeviceModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [deviceGroupId, setDeviceGroupId] = useState("");
  const [deviceType, setDeviceType] = useState("server");
  const [vendor, setVendor] = useState("");
  const [location, setLocation] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [interfaces, setInterfaces] = useState<DeviceInterfaceInput[]>([]);

  const [discoveringIndex, setDiscoveringIndex] = useState<number | null>(null);
  const [discoveryResult, setDiscoveryResult] = useState<DiscoveryResult | null>(null);

  const { data: groups } = useDeviceGroups();
  const createDevice = useCreateDevice();

  function addInterface() {
    setInterfaces((prev) => [...prev, { interface_type: "snmp", ip_address: "", port: undefined, snmp_community: "public" }]);
  }
  function updateInterface(i: number, patch: Partial<DeviceInterfaceInput>) {
    setInterfaces((prev) => prev.map((iface, idx) => (idx === i ? { ...iface, ...patch } : iface)));
  }
  function removeInterface(i: number) {
    setInterfaces((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleDiscover(i: number) {
    const iface = interfaces[i];
    if (!iface.ip_address) return;
    setDiscoveringIndex(i);
    setDiscoveryResult(null);
    try {
      const result = await discoverDevice(iface.ip_address, iface.snmp_community || "public");
      setDiscoveryResult(result);
      if (result.reachable && result.sysDescr && !name) {
        const guess = result.sysDescr.split(" ")[0];
        setName(`${guess}-${iface.ip_address.split(".").pop()}`);
      }
    } catch (err) {
      setDiscoveryResult({ reachable: false, error: (err as Error).message });
    } finally {
      setDiscoveringIndex(null);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const tags = tagsInput.split(",").map((t) => t.trim()).filter(Boolean);
    createDevice.mutate(
      {
        name,
        device_type: deviceType,
        vendor: vendor || undefined,
        location: location || undefined,
        latitude: latitude ? Number(latitude) : undefined,
        longitude: longitude ? Number(longitude) : undefined,
        tags: tags.length ? tags : undefined,
        interfaces: interfaces.filter((i) => i.ip_address)
      },
      {
        onSuccess: async (device) => {
          if (deviceGroupId) {
            await assignDeviceToGroup(deviceGroupId, device.id);
          }
          onClose();
        }
      }
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <form onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()} className="bg-surface-2 border border-border rounded-xl p-5 w-[460px] max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-medium">Cihaz ekle</h2>
          <button type="button" onClick={onClose} className="text-text-muted"><X size={18} /></button>
        </div>

        {createDevice.isError && <p className="text-sm text-[var(--text-danger)] mb-3">{(createDevice.error as Error).message}</p>}

        <div className="flex flex-col gap-3">
          <FormField label="İsim" required>
            <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" placeholder="core-sw-01" />
          </FormField>

          <FormField label="Host grubu" required>
            <select value={deviceGroupId} onChange={(e) => setDeviceGroupId(e.target.value)} required className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1">
              <option value="">Grup seç</option>
              {groups?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </FormField>

          <FormField label="Tip">
            <select value={deviceType} onChange={(e) => setDeviceType(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1">
              {DEVICE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </FormField>

          {/* Zabbix'in "Interfaces" bölümü — opsiyonel, çoklu, her biri kendi tipiyle. */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs text-text-secondary">Interface'ler (opsiyonel)</label>
              <button type="button" onClick={addInterface} className="flex items-center gap-1 text-xs text-text-accent">
                <Plus size={13} />
                Interface ekle
              </button>
            </div>
            {interfaces.length === 0 && (
              <p className="text-[11px] text-text-muted">Hiç interface eklenmedi. Bu cihaz izlenemeyecek — en az bir interface (SNMP/SSH/SQL/Web/VMware) eklemen önerilir.</p>
            )}
            {interfaces.some((i) => i.interface_type === "vmware") && (
              <p className="text-[11px] text-text-muted mb-1.5">
                VMware kullanıcı adı/şifresi burada girilmez — <a href="/macros" className="text-text-accent underline">Makrolar</a> sayfasında
                {" "}<code className="font-mono">{"{$VMWARE_USER}"}</code> ve <code className="font-mono">{"{$VMWARE_PASSWORD}"}</code> tanımlanmalı
                (tenant/cihaz grubu seviyesinde bir kez tanımlanıp tüm vCenter'lar tarafından paylaşılabilir).
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
                    {iface.interface_type === "snmp" && (
                      <button type="button" onClick={() => handleDiscover(i)} disabled={!iface.ip_address || discoveringIndex === i} className="shrink-0 text-text-muted hover:text-text-accent disabled:opacity-40">
                        <Radar size={14} className={discoveringIndex === i ? "animate-spin" : ""} />
                      </button>
                    )}
                    <button type="button" onClick={() => removeInterface(i)} className="shrink-0 text-text-muted hover:text-[var(--text-danger)]">
                      <Trash2 size={13} />
                    </button>
                  </div>
                  {iface.interface_type === "vmware" && (
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
                        <input type="checkbox" checked={iface.tls_skip_verify ?? false} onChange={(e) => updateInterface(i, { tls_skip_verify: e.target.checked })} />
                        Sertifika doğrulamayı atla (self-signed lab ortamları için)
                      </label>
                    </div>
                  )}
                  {discoveryResult && discoveringIndex === null && (
                    <div className={`text-[11px] p-1.5 rounded flex items-start gap-1.5 ${discoveryResult.reachable ? "bg-[var(--bg-success)] text-[var(--text-success)]" : "bg-[var(--bg-danger)] text-[var(--text-danger)]"}`}>
                      {discoveryResult.reachable ? <CircleCheck size={12} className="shrink-0 mt-0.5" /> : <CircleX size={12} className="shrink-0 mt-0.5" />}
                      <span>{discoveryResult.reachable ? `Bulundu: ${discoveryResult.sysDescr}` : `Ulaşılamadı: ${discoveryResult.error}`}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <FormField label="Üretici (opsiyonel)">
            <input value={vendor} onChange={(e) => setVendor(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" placeholder="cisco" />
          </FormField>
          <FormField label="Lokasyon (opsiyonel)">
            <input value={location} onChange={(e) => setLocation(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" placeholder="İstanbul DC1" />
          </FormField>
          {/* Coğrafi Harita: opsiyonel koordinat -- boş bırakılırsa cihaz haritada görünmez. */}
          <div className="flex gap-2">
            <FormField label="Enlem (opsiyonel)">
              <input type="number" step="any" min={-90} max={90} value={latitude} onChange={(e) => setLatitude(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" placeholder="41.0082" />
            </FormField>
            <FormField label="Boylam (opsiyonel)">
              <input type="number" step="any" min={-180} max={180} value={longitude} onChange={(e) => setLongitude(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" placeholder="28.9784" />
            </FormField>
          </div>
          <FormField label="Etiketler (virgülle ayır, opsiyonel)">
            <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" placeholder="prod, kritik" />
          </FormField>
        </div>

        <button type="submit" disabled={createDevice.isPending} className="w-full mt-4 py-2 text-sm rounded-md bg-[var(--text-accent)] text-white">
          {createDevice.isPending ? "Ekleniyor..." : "Cihaz ekle"}
        </button>
      </form>
    </div>
  );
}

function FormField({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div>
      <label className="text-xs text-text-secondary mb-1 block">
        {label} {required && <span className="text-[var(--text-danger)]">*</span>}
      </label>
      {children}
    </div>
  );
}
