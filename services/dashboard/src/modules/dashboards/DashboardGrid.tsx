import React, { useState } from "react";
import GridLayoutBase from "react-grid-layout";
const GridLayout = GridLayoutBase as any;
import { Trash2, Plus, LayoutGrid, BarChart3, AlertTriangle, Activity, Hash } from "lucide-react";
import { useDashboardWidgets, useCreateWidget, useUpdateWidget, useDeleteWidget } from "./useDashboards";
import { WidgetRenderer } from "./WidgetRenderer";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

const WIDGET_TYPE_META: Record<string, { label: string; icon: React.ReactNode }> = {
  kpi_card: { label: "KPI Kartı", icon: <Hash size={13} /> },
  problem_list: { label: "Alarm Listesi", icon: <AlertTriangle size={13} /> },
  device_status: { label: "Cihaz Durumu", icon: <Activity size={13} /> },
  graph: { label: "Grafik", icon: <BarChart3 size={13} /> }
};

export function DashboardGrid({ dashboardId }: { dashboardId: string }) {
  const { data: widgets, isLoading } = useDashboardWidgets(dashboardId);
  const createWidget = useCreateWidget(dashboardId);
  const updateWidget = useUpdateWidget(dashboardId);
  const deleteWidget = useDeleteWidget(dashboardId);

  const [showAddForm, setShowAddForm] = useState(false);
  const [newWidgetType, setNewWidgetType] = useState("kpi_card");
  const [newWidgetTitle, setNewWidgetTitle] = useState("");
  const [newWidgetConfig, setNewWidgetConfig] = useState("{}");

  function handleAddWidget(e: React.FormEvent) {
    e.preventDefault();
    let config = {};
    try {
      config = JSON.parse(newWidgetConfig);
    } catch {
      alert("Config geçerli bir JSON olmalı");
      return;
    }
    createWidget.mutate(
      { widget_type: newWidgetType as any, title: newWidgetTitle || undefined, config, position_x: 0, position_y: 0, width: 4, height: 3 },
      { onSuccess: () => { setNewWidgetTitle(""); setNewWidgetConfig("{}"); setShowAddForm(false); } }
    );
  }

  function handleLayoutChange(layout: any[]) {
    for (const item of layout) {
      const widget = widgets?.find((w) => w.id === item.i);
      if (!widget) continue;
      if (widget.position_x !== item.x || widget.position_y !== item.y || widget.width !== item.w || widget.height !== item.h) {
        updateWidget.mutate({ id: widget.id, input: { position_x: item.x, position_y: item.y, width: item.w, height: item.h } });
      }
    }
  }

  if (isLoading) return <p className="text-sm text-text-secondary">Yükleniyor...</p>;

  const layout = (widgets || []).map((w) => ({ i: w.id, x: w.position_x, y: w.position_y, w: w.width, h: w.height }));

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button
          onClick={() => setShowAddForm((v) => !v)}
          className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg bg-[var(--text-accent)] text-white hover:opacity-90 transition-opacity shadow-sm"
        >
          <Plus size={16} />
          Widget ekle
        </button>
      </div>

      {showAddForm && (
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

      {widgets && widgets.length > 0 ? (
        <GridLayout
          className="layout"
          layout={layout}
          cols={12}
          rowHeight={60}
          width={1200}
          onLayoutChange={handleLayoutChange as any}
          draggableHandle=".widget-drag-handle"
          margin={[12, 12]}
        >
          {widgets.map((widget) => {
            const meta = WIDGET_TYPE_META[widget.widget_type];
            return (
              <div key={widget.id} className="group bg-surface-2 border border-border rounded-2xl overflow-hidden flex flex-col shadow-sm hover:shadow-md transition-shadow">
                <div className="widget-drag-handle flex items-center justify-between px-3 py-2 bg-surface-1/60 border-b border-border cursor-move">
                  <span className="flex items-center gap-1.5 text-[11px] text-text-secondary font-medium">
                    {meta?.icon}
                    {meta?.label ?? widget.widget_type}
                  </span>
                  <button
                    onClick={() => deleteWidget.mutate(widget.id)}
                    className="text-text-muted hover:text-[var(--text-danger)] opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <div className="flex-1 p-3 overflow-hidden">
                  <WidgetRenderer widget={widget} />
                </div>
              </div>
            );
          })}
        </GridLayout>
      ) : (
        <div className="flex flex-col items-center justify-center py-20 text-center border-2 border-dashed border-border rounded-2xl">
          <LayoutGrid size={32} className="text-text-muted mb-3" />
          <p className="text-sm font-medium mb-1">Bu pano henüz boş</p>
          <p className="text-xs text-text-muted mb-4">Grafik, alarm listesi, cihaz durumu ya da KPI kartı ekleyerek başla</p>
          <button
            onClick={() => setShowAddForm(true)}
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
