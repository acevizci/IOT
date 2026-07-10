import { useState, useEffect } from "react";
import { Plus, LayoutDashboard, Trash2, Check } from "lucide-react";
import { useDashboards, useCreateDashboard, useDeleteDashboard, useUpdateDashboard } from "./useDashboards";
import { useDevices } from "../devices/useDevices";
import { useDeviceGroups } from "../deviceGroups/useDeviceGroups";
import { DashboardGrid } from "./DashboardGrid";

const HOURS_OPTIONS = [
  { value: 1, label: "1 saat" },
  { value: 6, label: "6 saat" },
  { value: 24, label: "24 saat" },
  { value: 168, label: "7 gün" }
];

export function DashboardPage() {
  const { data: dashboards, isLoading } = useDashboards();
  const createDashboard = useCreateDashboard();
  const deleteDashboard = useDeleteDashboard();
  const updateDashboard = useUpdateDashboard();

  const [activeDashboardId, setActiveDashboardId] = useState<string>("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newDashboardName, setNewDashboardName] = useState("");

  const activeDashboard = dashboards?.find((d) => d.id === activeDashboardId);

  // Faz 9.4 + 9.8 + 9.10c — panonun bağlamı (hangi cihaz/host grubu/zaman aralığı).
  // Aktif pano değişince, o panonun kalıcı varsayılanlarıyla sıfırlanır. Bu seçiciyi
  // değiştirmek SADECE bu oturumdaki görünümü etkiler; kalıcı hale getirmek için
  // "Varsayılan yap" butonuna basmak gerekir. Faz 9.5'ten itibaren, "Veri kaynağı: Pano"
  // moduna alınan graph/device_status widget'ları bu bağlamı gerçekten kullanıyor.
  const [contextDeviceId, setContextDeviceId] = useState<string>("");
  const [contextDeviceGroupId, setContextDeviceGroupId] = useState<string>("");
  const [contextHours, setContextHours] = useState<number>(6);

  const { data: devicesData } = useDevices({ limit: 200 });
  const devices = devicesData?.items;
  const { data: deviceGroups } = useDeviceGroups();

  useEffect(() => {
    if (dashboards && dashboards.length > 0 && !activeDashboardId) {
      setActiveDashboardId(dashboards[0].id);
    }
  }, [dashboards, activeDashboardId]);

  useEffect(() => {
    if (!activeDashboard) return;
    setContextDeviceId(activeDashboard.default_device_id || "");
    setContextDeviceGroupId(activeDashboard.default_device_group_id || "");
    setContextHours(activeDashboard.default_hours || 6);
  }, [activeDashboard?.id]);

  const isDirtyContext =
    !!activeDashboard &&
    ((activeDashboard.default_device_id || "") !== contextDeviceId ||
      (activeDashboard.default_device_group_id || "") !== contextDeviceGroupId ||
      (activeDashboard.default_hours || 6) !== contextHours);

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createDashboard.mutate(
      { name: newDashboardName },
      { onSuccess: (d) => { setActiveDashboardId(d.id); setNewDashboardName(""); setShowCreateForm(false); } }
    );
  }

  function handleSaveAsDefault() {
    if (!activeDashboardId) return;
    updateDashboard.mutate({
      id: activeDashboardId,
      input: {
        default_device_id: contextDeviceId || null,
        default_device_group_id: contextDeviceGroupId || null,
        default_hours: contextHours
      }
    });
  }

  if (isLoading) return <p className="text-sm text-text-secondary">Yükleniyor...</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-3 pb-3 border-b border-border">
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
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-2xl p-4 mb-4 flex items-center gap-2 shadow-sm">
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

      {activeDashboardId && (
        <div className="flex items-center gap-2 mb-4 flex-wrap text-xs">
          <span className="text-text-muted shrink-0">Bağlam:</span>
          <select value={contextDeviceId} onChange={(e) => setContextDeviceId(e.target.value)} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
            <option value="">Cihaz seçilmedi</option>
            {devices?.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <select value={contextDeviceGroupId} onChange={(e) => setContextDeviceGroupId(e.target.value)} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
            <option value="">Host grubu seçilmedi</option>
            {deviceGroups?.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
          <select value={contextHours} onChange={(e) => setContextHours(Number(e.target.value))} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
            {HOURS_OPTIONS.map((h) => (
              <option key={h.value} value={h.value}>{h.label}</option>
            ))}
          </select>
          {isDirtyContext && (
            <button
              onClick={handleSaveAsDefault}
              disabled={updateDashboard.isPending}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50"
            >
              <Check size={12} />
              Varsayılan yap
            </button>
          )}
          {updateDashboard.isError && <span className="text-[var(--text-danger)]">Kaydedilemedi (yetkiniz olmayabilir)</span>}
        </div>
      )}

      {activeDashboardId ? (
        <DashboardGrid
          dashboardId={activeDashboardId}
          dashboardContext={{
            deviceId: contextDeviceId || null,
            deviceGroupId: contextDeviceGroupId || null,
            hours: contextHours
          }}
        />
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
