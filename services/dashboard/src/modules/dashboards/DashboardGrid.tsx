import { useState } from "react";
import GridLayout from "react-grid-layout";
import { Trash2, Plus } from "lucide-react";
import { useDashboardWidgets, useCreateWidget, useUpdateWidget, useDeleteWidget } from "./useDashboards";
import { WidgetRenderer } from "./WidgetRenderer";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

const WIDGET_TYPE_LABELS: Record<string, string> = {
  kpi_card: "KPI Kartı",
  problem_list: "Alarm Listesi",
  device_status: "Cihaz Durumu",
  graph: "Grafik"
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

  function handleLayoutChange(layout: Array<{ i: string; x: number; y: number; w: number; h: number }>) {
    // Her widget'ın son pozisyon/boyutunu backend'e kaydet — sürükleme/boyutlandırma bitince tetiklenir
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
        <button onClick={() => setShowAddForm((v) => !v)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
          <Plus size={15} />
          Widget ekle
        </button>
      </div>

      {showAddForm && (
        <form onSubmit={handleAddWidget} className="bg-surface-2 border border-border rounded-xl p-4 mb-4 flex flex-col gap-2">
          <select value={newWidgetType} onChange={(e) => setNewWidgetType(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1">
            {Object.entries(WIDGET_TYPE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <input value={newWidgetTitle} onChange={(e) => setNewWidgetTitle(e.target.value)} placeholder="Başlık (opsiyonel)" className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
          <textarea
            value={newWidgetConfig}
            onChange={(e) => setNewWidgetConfig(e.target.value)}
            placeholder='{"source":"open_alerts"} veya {"device_id":"...","metric_name":"..."}'
            className="px-2.5 py-1.5 text-xs font-mono rounded-md border border-border bg-surface-1 h-16"
          />
          <button type="submit" className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white w-fit">Ekle</button>
        </form>
      )}

      {widgets && widgets.length > 0 ? (
        <GridLayout
          className="layout"
          layout={layout}
          cols={12}
          rowHeight={60}
          width={1200}
          onLayoutChange={handleLayoutChange}
          draggableHandle=".widget-drag-handle"
        >
          {widgets.map((widget) => (
            <div key={widget.id} className="bg-surface-2 border border-border rounded-xl overflow-hidden flex flex-col">
              <div className="widget-drag-handle flex items-center justify-between px-2 py-1 bg-surface-1 border-b border-border cursor-move">
                <span className="text-[10px] text-text-muted">{WIDGET_TYPE_LABELS[widget.widget_type]}</span>
                <button onClick={() => deleteWidget.mutate(widget.id)} className="text-text-muted hover:text-[var(--text-danger)]"><Trash2 size={11} /></button>
              </div>
              <div className="flex-1 p-2 overflow-hidden">
                <WidgetRenderer widget={widget} />
              </div>
            </div>
          ))}
        </GridLayout>
      ) : (
        <p className="text-sm text-text-muted">Bu panoda henüz widget yok. "Widget ekle" ile başla.</p>
      )}
    </div>
  );
}
