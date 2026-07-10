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
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          {dashboards?.map((d) => (
            <button
              key={d.id}
              onClick={() => setActiveDashboardId(d.id)}
              className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md ${activeDashboardId === d.id ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary hover:bg-surface-1"}`}
            >
              <LayoutDashboard size={14} />
              {d.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {activeDashboardId && dashboards && dashboards.length > 1 && (
            <button
              onClick={() => {
                deleteDashboard.mutate(activeDashboardId);
                setActiveDashboardId("");
              }}
              className="text-text-muted hover:text-[var(--text-danger)]"
            >
              <Trash2 size={15} />
            </button>
          )}
          <button onClick={() => setShowCreateForm((v) => !v)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
            <Plus size={15} />
            Yeni Pano
          </button>
        </div>
      </div>

      {showCreateForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-3 mb-4 flex items-center gap-2">
          <input value={newDashboardName} onChange={(e) => setNewDashboardName(e.target.value)} placeholder="Pano adı" required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 flex-1" />
          <button type="submit" className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">Oluştur</button>
        </form>
      )}

      {activeDashboardId ? (
        <DashboardGrid dashboardId={activeDashboardId} />
      ) : (
        <p className="text-sm text-text-muted">Henüz bir pano yok. "Yeni Pano" ile başla.</p>
      )}
    </div>
  );
}
