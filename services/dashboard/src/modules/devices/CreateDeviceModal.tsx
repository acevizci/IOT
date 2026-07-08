import { useState } from "react";
import { X, Radar, CircleCheck, CircleX } from "lucide-react";
import { useCreateDevice } from "./useDevices";
import { discoverDevice } from "../../api/discovery";
import type { DiscoveryResult } from "../../api/discovery";

const DEVICE_TYPES = ["switch", "firewall", "server", "load_balancer", "router"];

export function CreateDeviceModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [ipAddress, setIpAddress] = useState("");
  const [community, setCommunity] = useState("public");
  const [deviceType, setDeviceType] = useState("server");
  const [vendor, setVendor] = useState("");
  const [location, setLocation] = useState("");
  const [tagsInput, setTagsInput] = useState("");

  const [discovering, setDiscovering] = useState(false);
  const [discoveryResult, setDiscoveryResult] = useState<DiscoveryResult | null>(null);

  const createDevice = useCreateDevice();

  async function handleDiscover() {
    if (!ipAddress) return;
    setDiscovering(true);
    setDiscoveryResult(null);
    try {
      const result = await discoverDevice(ipAddress, community);
      setDiscoveryResult(result);
      if (result.reachable && result.sysDescr && !name) {
        // sysDescr'den ilk kelimeyi (genelde OS adı) öneri olarak isme koy
        const guess = result.sysDescr.split(" ")[0];
        setName(`${guess}-${ipAddress.split(".").pop()}`);
      }
    } catch (err) {
      setDiscoveryResult({ reachable: false, error: (err as Error).message });
    } finally {
      setDiscovering(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const tags = tagsInput.split(",").map((t) => t.trim()).filter(Boolean);
    createDevice.mutate(
      {
        name,
        ip_address: ipAddress,
        device_type: deviceType,
        vendor: vendor || undefined,
        location: location || undefined,
        tags: tags.length ? tags : undefined
      },
      { onSuccess: onClose }
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <form onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()} className="bg-surface-2 border border-border rounded-xl p-5 w-[420px]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-medium">Cihaz ekle</h2>
          <button type="button" onClick={onClose} className="text-text-muted"><X size={18} /></button>
        </div>

        {createDevice.isError && <p className="text-sm text-[var(--text-danger)] mb-3">{(createDevice.error as Error).message}</p>}

        <div className="flex flex-col gap-3">
          <FormField label="IP adresi">
            <div className="flex gap-2">
              <input
                value={ipAddress}
                onChange={(e) => { setIpAddress(e.target.value); setDiscoveryResult(null); }}
                required
                className="flex-1 px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
                placeholder="192.168.1.10"
              />
              <input
                value={community}
                onChange={(e) => setCommunity(e.target.value)}
                className="w-24 px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
                placeholder="public"
              />
              <button
                type="button"
                onClick={handleDiscover}
                disabled={!ipAddress || discovering}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border-strong hover:bg-surface-1 shrink-0 disabled:opacity-50"
              >
                <Radar size={14} className={discovering ? "animate-spin" : ""} />
                {discovering ? "..." : "Keşfet"}
              </button>
            </div>
            <p className="text-[11px] text-text-muted mt-1">SNMP community string ile (varsayılan: public)</p>
          </FormField>

          {discoveryResult && (
            <div className={`text-xs p-2.5 rounded-md flex items-start gap-2 ${discoveryResult.reachable ? "bg-[var(--bg-success)] text-[var(--text-success)]" : "bg-[var(--bg-danger)] text-[var(--text-danger)]"}`}>
              {discoveryResult.reachable ? <CircleCheck size={15} className="shrink-0 mt-0.5" /> : <CircleX size={15} className="shrink-0 mt-0.5" />}
              <div>
                {discoveryResult.reachable ? (
                  <>
                    <p className="font-medium">Cihaz bulundu</p>
                    <p className="opacity-90 mt-0.5">{discoveryResult.sysDescr}</p>
                    <p className="opacity-90 mt-0.5">
                      {discoveryResult.interfaceCount} interface: {discoveryResult.interfaceNames?.join(", ")}
                    </p>
                  </>
                ) : (
                  <p>Cihaza ulaşılamadı: {discoveryResult.error}</p>
                )}
              </div>
            </div>
          )}

          <FormField label="İsim">
            <input value={name} onChange={(e) => setName(e.target.value)} required className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" placeholder="core-sw-01" />
          </FormField>
          <FormField label="Tip">
            <select value={deviceType} onChange={(e) => setDeviceType(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1">
              {DEVICE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </FormField>
          <FormField label="Üretici (opsiyonel)">
            <input value={vendor} onChange={(e) => setVendor(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" placeholder="cisco" />
          </FormField>
          <FormField label="Lokasyon (opsiyonel)">
            <input value={location} onChange={(e) => setLocation(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" placeholder="İstanbul DC1" />
          </FormField>
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

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-text-secondary mb-1 block">{label}</label>
      {children}
    </div>
  );
}
