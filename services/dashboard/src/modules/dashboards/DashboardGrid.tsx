import React, { useState, useEffect } from "react";
import GridLayoutBase from "react-grid-layout";
const GridLayout = GridLayoutBase as any;
import { Trash2, Plus, LayoutGrid, BarChart3, AlertTriangle, Activity, Hash, Pencil, Check, X as XIcon } from "lucide-react";
import { useDashboardWidgets, useBulkUpdateWidgets } from "./useDashboards";
import { WidgetRenderer } from "./WidgetRenderer";
import type { DashboardWidget } from "../../api/dashboards";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

const WIDGET_TYPE_META: Record<string, { label: string; icon: React.ReactNode }> = {
  kpi_card: { label: "KPI Kartı", icon: <Hash size={13} /> },
  problem_list: { label: "Alarm Listesi", icon: <AlertTriangle size={13} /> },
  device_status: { label: "Cihaz Durumu", icon: <Activity size={13} /> },
  graph: { label: "Grafik", icon: <BarChart3 size={13} /> }
};

// Düzenleme modundaki widget'lar için yerel taslak tipi. Henüz kaydedilmemiş yeni
// widget'ların gerçek (DB) id'si yoktur — React'in key'i ve grid'in "hangi öğe" bilgisi
// için sabit bir clientKey kullanılır, id ile karıştırılmaz.
interface EditableWidget {
  clientKey: string;
  id?: string;
  widget_type: DashboardWidget["widget_type"];
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  title: string | null;
  config: Record<string, any>;
}

function toEditable(widgets: DashboardWidget[]): EditableWidget[] {
  return widgets.map((w) => ({
    clientKey: w.id,
    id: w.id,
    widget_type: w.widget_type,
    position_x: w.position_x,
    position_y: w.position_y,
    width: w.width,
    height: w.height,
    title: w.title,
    config: w.config
  }));
}

let tempKeyCounter = 0;
function nextTempKey() {
  tempKeyCounter += 1;
  return `temp-${Date.now()}-${tempKeyCounter}`;
}

export function DashboardGrid({ dashboardId }: { dashboardId: string }) {
  const { data: widgets, isLoading } = useDashboardWidgets(dashboardId);
  const bulkUpdate = useBulkUpdateWidgets(dashboardId);

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<EditableWidget[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newWidgetType, setNewWidgetType] = useState("kpi_card");
  const [newWidgetTitle, setNewWidgetTitle] = useState("");
  const [newWidgetConfig, setNewWidgetConfig] = useState("{}");

  // Düzenleme moduna girerken sunucudaki son hâli yerel taslağa kopyala — buradan
  // sonraki her değişiklik (sürükle/boyutlandır/ekle/sil) sadece bu taslağı günceller,
  // "Kaydet"e basılana kadar hiçbir API çağrısı yapılmaz (eski davranış: her sürüklemede
  // otomatik PATCH atıyordu, artık öyle değil — bkz. Faz 9.6).
  function startEditing() {
    setDraft(toEditable(widgets || []));
    setIsEditing(true);
  }

  function cancelEditing() {
    setIsEditing(false);
    setDraft([]);
    setShowAddForm(false);
  }

  function saveEditing() {
    const payload = draft.map((w) => ({
      id: w.id,
      widget_type: w.widget_type,
      position_x: w.position_x,
      position_y: Number.isFinite(w.position_y) ? w.position_y : 0,
      width: w.width,
      height: w.height,
      title: w.title || undefined,
      config: w.config
    }));
    bulkUpdate.mutate(payload, {
      onSuccess: () => {
        setIsEditing(false);
        setDraft([]);
      }
    });
  }

  // Kaydedilmemiş değişiklik varken sayfadan ayrılma uyarısı (madde 9.10ı)
  useEffect(() => {
    if (!isEditing) return;
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isEditing]);

  function handleAddWidget(e: React.FormEvent) {
    e.preventDefault();
    let config = {};
    try {
      config = JSON.parse(newWidgetConfig);
    } catch {
      alert("Config geçerli bir JSON olmalı");
      return;
    }
    setDraft((prev) => [
      ...prev,
      {
        clientKey: nextTempKey(),
        widget_type: newWidgetType as any,
        title: newWidgetTitle || null,
        config,
        position_x: 0,
        position_y: Infinity, // react-grid-layout: Infinity = mevcut en alt satırın altına otomatik yerleş
        width: 4,
        height: 3
      }
    ]);
    setNewWidgetTitle("");
    setNewWidgetConfig("{}");
    setShowAddForm(false);
  }

  function handleRemoveWidget(clientKey: string) {
    setDraft((prev) => prev.filter((w) => w.clientKey !== clientKey));
  }

  function handleLayoutChange(layout: any[]) {
    setDraft((prev) =>
      prev.map((w) => {
        const item = layout.find((l) => l.i === w.clientKey);
        if (!item) return w;
        return { ...w, position_x: item.x, position_y: item.y, width: item.w, height: item.h };
      })
    );
  }

  if (isLoading) return <p className="text-sm text-text-secondary">Yükleniyor...</p>;

  const displayWidgets: EditableWidget[] = isEditing ? draft : toEditable(widgets || []);
  const layout = displayWidgets.map((w) => ({ i: w.clientKey, x: w.position_x, y: w.position_y, w: w.width, h: w.height }));

  return (
    <div>
      <div className="flex justify-end mb-3 gap-2">
        {!isEditing ? (
          <button
            onClick={startEditing}
            className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg border border-border-strong hover:bg-surface-1 transition-colors"
          >
            <Pencil size={14} />
            Düzenle
          </button>
        ) : (
          <>
            <button
              onClick={() => setShowAddForm((v) => !v)}
              className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg bg-[var(--text-accent)] text-white hover:opacity-90 transition-opacity shadow-sm"
            >
              <Plus size={16} />
              Widget ekle
            </button>
            <button onClick={cancelEditing} className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg text-text-secondary hover:bg-surface-1">
              <XIcon size={15} />
              Vazgeç
            </button>
            <button
              onClick={saveEditing}
              disabled={bulkUpdate.isPending}
              className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg bg-[var(--text-success)] text-white hover:opacity-90 disabled:opacity-50"
            >
              <Check size={15} />
              Kaydet
            </button>
          </>
        )}
      </div>

      {bulkUpdate.isError && (
        <p className="text-sm text-[var(--text-danger)] mb-3">Kaydedilemedi: {(bulkUpdate.error as Error).message}</p>
      )}

      {isEditing && showAddForm && (
        <form onSubmit={handleAddWidget} className="bg-surface-2 border border-border rounded-2xl p-5 mb-5 flex flex-col gap-3 shadow-sm">
          <div className="grid grid-cols-4 gap-2">
            {Object.entries(WIDGET_TYPE_META).map(([key, meta]) => (
              <button
                key={key}
                type="button"
                onClick={() => setNewWidgetType(key)}
                className={`flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl border text-xs transition-colors ${
                  newWidgetType === key
                    ? "border-[var(--text-accent)] bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium"
                    : "border-border text-text-secondary hover:bg-surface-1"
                }`}
              >
                {meta.icon}
                {meta.label}
              </button>
            ))}
          </div>
          <input
            value={newWidgetTitle}
            onChange={(e) => setNewWidgetTitle(e.target.value)}
            placeholder="Başlık (opsiyonel)"
            className="px-3 py-2 text-sm rounded-lg border border-border bg-surface-1"
          />
          <textarea
            value={newWidgetConfig}
            onChange={(e) => setNewWidgetConfig(e.target.value)}
            placeholder='{"source":"open_alerts"} veya {"device_id":"...","metric_name":"..."}'
            className="px-3 py-2 text-xs font-mono rounded-lg border border-border bg-surface-1 h-16"
          />
          <div className="flex items-center gap-2 justify-end">
            <button type="button" onClick={() => setShowAddForm(false)} className="px-3.5 py-2 text-sm rounded-lg text-text-secondary hover:bg-surface-1">
              Vazgeç
            </button>
            <button type="submit" className="px-3.5 py-2 text-sm rounded-lg bg-[var(--text-accent)] text-white hover:opacity-90">
              Ekle
            </button>
          </div>
        </form>
      )}

      {displayWidgets.length > 0 ? (
        <GridLayout
          className="layout"
          layout={layout}
          cols={12}
          rowHeight={60}
          width={1200}
          onLayoutChange={isEditing ? (handleLayoutChange as any) : undefined}
          isDraggable={isEditing}
          isResizable={isEditing}
          draggableHandle=".widget-drag-handle"
          margin={[12, 12]}
        >
          {displayWidgets.map((widget) => {
            const meta = WIDGET_TYPE_META[widget.widget_type];
            return (
              <div
                key={widget.clientKey}
                className="group bg-surface-2 border border-border rounded-2xl overflow-hidden flex flex-col shadow-sm hover:shadow-md transition-shadow"
              >
                <div
                  className={`flex items-center justify-between px-3 py-2 bg-surface-1/60 border-b border-border ${
                    isEditing ? "widget-drag-handle cursor-move" : ""
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-[11px] text-text-secondary font-medium">
                    {meta?.icon}
                    {widget.title || meta?.label || widget.widget_type}
                  </span>
                  {isEditing && (
                    <button
                      onClick={() => handleRemoveWidget(widget.clientKey)}
                      className="text-text-muted hover:text-[var(--text-danger)] opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
                <div className="flex-1 p-3 overflow-hidden">
                  <WidgetRenderer widget={widget as DashboardWidget} />
                </div>
              </div>
            );
          })}
        </GridLayout>
      ) : (
        <div className="flex flex-col items-center justify-center py-20 text-center border-2 border-dashed border-border rounded-2xl">
          <LayoutGrid size={32} className="text-text-muted mb-3" />
          <p className="text-sm font-medium mb-1">Bu pano henüz boş</p>
          <p className="text-xs text-text-muted mb-4">
            {isEditing ? "Grafik, alarm listesi, cihaz durumu ya da KPI kartı ekleyerek başla" : "Düzenle'ye basıp widget ekleyerek başla"}
          </p>
          <button
            onClick={() => {
              if (!isEditing) startEditing();
              setShowAddForm(true);
            }}
            className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg bg-[var(--text-accent)] text-white hover:opacity-90"
          >
            <Plus size={15} />
            İlk widget'ı ekle
          </button>
        </div>
      )}
    </div>
  );
}
