import { useState, useEffect } from "react";
import { Plus, LayoutDashboard, Trash2 } from "lucide-react";
import { useDashboards, useCreateDashboard, useDeleteDashboard } from "./useDashboards";
import { DashboardGrid } from "./DashboardGrid";

export function DashboardPage() {
  const { data: dashboards, isLoading } = useDashboards();
  const createDashboard = useCreateDashboard();
  const deleteDashboard = useDeleteDashboard();

  const [activeDashboardId, setActiveDashboardId] = useState<string>("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newDashboardName, setNewDashboardName] = useState("");

  useEffect(() => {
    if (dashboards && dashboards.length > 0 && !activeDashboardId) {
      setActiveDashboardId(dashboards[0].id);
    }
  }, [dashboards, activeDashboardId]);

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createDashboard.mutate(
      { name: newDashboardName },
      { onSuccess: (d) => { setActiveDashboardId(d.id); setNewDashboardName(""); setShowCreateForm(false); } }
    );
  }

  if (isLoading) return <p className="text-sm text-text-secondary">Yükleniyor...</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-5 pb-3 border-b border-border">
        <div className="flex items-center gap-1 flex-wrap">
          {dashboards?.map((d) => (
            <button
              key={d.id}
              onClick={() => setActiveDashboardId(d.id)}
              className={`flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg transition-colors ${
                activeDashboardId === d.id
                  ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium"
                  : "text-text-secondary hover:bg-surface-1"
              }`}
            >
              <LayoutDashboard size={14} />
              {d.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {activeDashboardId && dashboards && dashboards.length > 1 && (
            <button
              onClick={() => { deleteDashboard.mutate(activeDashboardId); setActiveDashboardId(""); }}
              className="text-text-muted hover:text-[var(--text-danger)] p-2 rounded-lg hover:bg-surface-1"
              title="Panoyu sil"
            >
              <Trash2 size={15} />
            </button>
          )}
          <button
            onClick={() => setShowCreateForm((v) => !v)}
            className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg border border-border-strong hover:bg-surface-1 transition-colors"
          >
            <Plus size={15} />
            Yeni Pano
          </button>
        </div>
      </div>

      {showCreateForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-2xl p-4 mb-5 flex items-center gap-2 shadow-sm">
          <input
            value={newDashboardName}
            onChange={(e) => setNewDashboardName(e.target.value)}
            placeholder="Pano adı"
            required
            autoFocus
            className="px-3 py-2 text-sm rounded-lg border border-border bg-surface-1 flex-1"
          />
          <button type="button" onClick={() => setShowCreateForm(false)} className="px-3.5 py-2 text-sm rounded-lg text-text-secondary hover:bg-surface-1">
            Vazgeç
          </button>
          <button type="submit" className="px-3.5 py-2 text-sm rounded-lg bg-[var(--text-accent)] text-white hover:opacity-90">
            Oluştur
          </button>
        </form>
      )}

      {activeDashboardId ? (
        <DashboardGrid dashboardId={activeDashboardId} />
      ) : (
        <div className="flex flex-col items-center justify-center py-20 text-center border-2 border-dashed border-border rounded-2xl">
          <LayoutDashboard size={32} className="text-text-muted mb-3" />
          <p className="text-sm font-medium mb-1">Henüz bir pano yok</p>
          <p className="text-xs text-text-muted mb-4">Kendi panonu oluşturup widget'lar ekleyerek özelleştir</p>
          <button
            onClick={() => setShowCreateForm(true)}
            className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg bg-[var(--text-accent)] text-white hover:opacity-90"
          >
            <Plus size={15} />
            İlk panoyu oluştur
          </button>
        </div>
      )}
    </div>
  );
}
