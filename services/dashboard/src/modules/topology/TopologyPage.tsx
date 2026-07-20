import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { TopologyGraph } from "./TopologyGraph";
import { useDevices } from "../devices/useDevices";
import { apiFetch } from "../../api/client";
export function TopologyPage() {
  const { data: devices } = useDevices({});
  const qc = useQueryClient();
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [deviceA, setDeviceA] = useState("");
  const [deviceB, setDeviceB] = useState("");
  const [interfaceA, setInterfaceA] = useState("");
  const [interfaceB, setInterfaceB] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function handleAddLink(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch("/api/v1/topology/links", {
        method: "POST",
        body: JSON.stringify({
          device_a_id: deviceA, device_b_id: deviceB,
          interface_a: interfaceA || undefined, interface_b: interfaceB || undefined
        })
      });
      qc.invalidateQueries({ queryKey: ["topology-full"] });
      setDeviceA(""); setDeviceB(""); setInterfaceA(""); setInterfaceB(""); setShowLinkForm(false);
    } catch (err: any) {
      setError(err.message || "Bağlantı eklenemedi");
    }
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium">Topoloji</h1>
          <p className="text-sm text-text-secondary">Düğümleri sürükleyerek konumlandır, bağlantı çizgileri alarm durumuna görerenklenir</p>
        </div>
        <button onClick={() => setShowLinkForm((v) => !v)} className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg border border-border-strong hover:bg-surface-1">
          <Plus size={15} />
          Bağlantı ekle
        </button>
      </div>
      {error && <p className="text-sm text-[var(--text-danger)] mb-3">{error}</p>}
      {showLinkForm && (
        <form onSubmit={handleAddLink} className="bg-surface-2 border border-border rounded-2xl p-4 mb-4 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <select value={deviceA} onChange={(e) => setDeviceA(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-lg border border-border bg-surface-1 flex-1">
              <option value="">Cihaz A</option>
              {devices?.items?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <input value={interfaceA} onChange={(e) => setInterfaceA(e.target.value)} placeholder="Interface (ops.), örn. GigE0/1" className="w-40 px-2.5 py-1.5 text-sm rounded-lg border border-border bg-surface-1" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-text-muted text-xs px-1">—</span>
            <select value={deviceB} onChange={(e) => setDeviceB(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-lg border border-border bg-surface-1 flex-1">
              <option value="">Cihaz B</option>
              {devices?.items?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <input value={interfaceB} onChange={(e) => setInterfaceB(e.target.value)} placeholder="Interface (ops.), örn. Gi1/0/24" className="w-40 px-2.5 py-1.5 text-sm rounded-lg border border-border bg-surface-1" />
          </div>
          <button type="submit" className="self-start px-3.5 py-2 text-sm rounded-lg bg-[var(--text-accent)] text-white hover:opacity-90">Ekle</button>
        </form>
      )}
      <TopologyGraph />
    </div>
  );
}
