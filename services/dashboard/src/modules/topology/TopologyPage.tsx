import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useTopology, useCreateLink, useDeleteLink } from "./useTopology";
import { TopologyGraph } from "./TopologyGraph";

const RANGE_OPTIONS = [
  { label: "Son 6 saat", hours: 6 },
  { label: "Son 24 saat", hours: 24 },
  { label: "Son 7 gün", hours: 168 }
];

export function TopologyPage() {
  const [hours, setHours] = useState(24);
  const { data, isLoading } = useTopology(hours);
  const createLink = useCreateLink();
  const deleteLink = useDeleteLink();

  const [deviceA, setDeviceA] = useState("");
  const [deviceB, setDeviceB] = useState("");
  const [showLinkForm, setShowLinkForm] = useState(false);

  function handleCreateLink(e: React.FormEvent) {
    e.preventDefault();
    if (!deviceA || !deviceB || deviceA === deviceB) return;
    createLink.mutate(
      { device_a_id: deviceA, device_b_id: deviceB },
      { onSuccess: () => { setDeviceA(""); setDeviceB(""); setShowLinkForm(false); } }
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-lg font-medium">Topoloji</h1>
          <p className="text-sm text-text-secondary mt-0.5">
            Kalın çizgiler trafik hacmini, kesikli çizgiler manuel tanımlı fiziksel bağlantıları gösterir
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 bg-surface-1 rounded-md p-1 border border-border">
            {RANGE_OPTIONS.map((r) => (
              <button key={r.hours} onClick={() => setHours(r.hours)} className={`text-xs px-2.5 py-1 rounded ${hours === r.hours ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
                {r.label}
              </button>
            ))}
          </div>
          <button onClick={() => setShowLinkForm((v) => !v)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
            <Plus size={15} />
            Bağlantı ekle
          </button>
        </div>
      </div>

      {showLinkForm && data && (
        <form onSubmit={handleCreateLink} className="bg-surface-2 border border-border rounded-xl p-4 mb-4 flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Cihaz A</label>
            <select value={deviceA} onChange={(e) => setDeviceA(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-48">
              <option value="">Seçin</option>
              {data.nodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Cihaz B</label>
            <select value={deviceB} onChange={(e) => setDeviceB(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-48">
              <option value="">Seçin</option>
              {data.nodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
          </div>
          <button type="submit" disabled={createLink.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
            Ekle
          </button>
        </form>
      )}

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      {data && (
        <div className="grid grid-cols-[1fr_260px] gap-4">
          <div className="bg-surface-2 border border-border rounded-xl p-4">
            {data.nodes.length === 0 ? (
              <p className="text-sm text-text-muted py-12 text-center">Henüz cihaz eklenmedi.</p>
            ) : (
              <TopologyGraph nodes={data.nodes} manualLinks={data.manualLinks} trafficEdges={data.trafficEdges} />
            )}
          </div>

          <div className="bg-surface-2 border border-border rounded-xl p-4">
            <p className="text-sm font-medium mb-3">Manuel bağlantılar</p>
            {data.manualLinks.map((link) => {
              const a = data.nodes.find((n) => n.id === link.device_a_id);
              const b = data.nodes.find((n) => n.id === link.device_b_id);
              return (
                <div key={link.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <span className="text-xs text-text-secondary">{a?.name ?? "?"} ↔ {b?.name ?? "?"}</span>
                  <button onClick={() => deleteLink.mutate(link.id)} className="text-text-muted hover:text-[var(--text-danger)]">
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
            {data.manualLinks.length === 0 && <p className="text-xs text-text-muted">Henüz bağlantı tanımlanmadı.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
