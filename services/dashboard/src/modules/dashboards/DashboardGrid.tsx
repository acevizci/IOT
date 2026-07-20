import React, { useState, useEffect } from "react";
import GridLayoutBase, { WidthProvider } from "react-grid-layout";
// react-grid-layout'un sürükleme matematiği, verilen "width" prop'una göre sütun
// genişliklerini hesaplıyor. Sabit width={1200} veriyorduk ama gerçek DOM konteyneri
// (kenar çubuğu/padding/ekran boyutuna göre) NADİREN tam 1200px oluyor -- bu fark,
// imleç ile sürüklenen widget arasında sapmaya yol açıyordu. WidthProvider, konteynerin
// GERÇEK ölçülmüş genişliğini otomatik enjekte eder -- sabit sayıya hiç gerek kalmaz.
const GridLayout = WidthProvider(GridLayoutBase) as any;
import { Trash2, Plus, LayoutGrid, BarChart3, AlertTriangle, Activity, Hash, Pencil, Check, X as XIcon, Settings2, PieChart, Server, Gauge as GaugeIcon, Globe, Zap, Clock, IdCard, Tag, Table, StickyNote, Link2, Compass, Grid3x3, Wifi, Rows3, HardDrive, Monitor, RadioTower, ScrollText } from "lucide-react";
import { useDashboardWidgets, useBulkUpdateWidgets } from "./useDashboards";
import { WidgetRenderer } from "./WidgetRenderer";
import { WidgetSettingsPanel } from "./WidgetSettingsPanel";
import type { DashboardWidget, DashboardContext } from "../../api/dashboards";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

// Faz 10 UX düzeltmesi -- bu widget tipleri, kendi config'inde device_group_id
// belirtilmemişse panonun üst "Bağlam" çubuğundaki host grubuna sessizce düşer
// (bkz. WidgetRenderer.tsx'teki effectiveConfig). Kullanıcı bunu bilmeden widget'ın
// neden boş/farklı veri gösterdiğini anlayamıyordu -- artık başlıkta küçük bir
// "Pano" rozetiyle açıkça gösteriliyor.
const GROUP_SCOPED_TYPES = new Set([
  "severity_distribution", "problem_devices", "top_n", "pie_chart", "device_explorer", "status_grid", "host_performance_table", "vmware_vm_table", "trap_log", "syslog_log"
]);

function usesDashboardContext(widget: { widget_type: string; config: Record<string, any> }, dashboardContext?: DashboardContext): boolean {
  const t = widget.widget_type;
  if (t === "graph") return widget.config?.device_source === "dashboard";
  if (t === "device_status") return widget.config?.group_source === "dashboard";
  if (GROUP_SCOPED_TYPES.has(t)) return !widget.config?.device_group_id && !!dashboardContext?.deviceGroupId;
  return false;
}

const WIDGET_TYPE_META: Record<string, { label: string; icon: React.ReactNode }> = {
  kpi_card: { label: "KPI Kartı", icon: <Hash size={13} /> },
  problem_list: { label: "Alarm Listesi", icon: <AlertTriangle size={13} /> },
  device_status: { label: "Cihaz Durumu", icon: <Activity size={13} /> },
  graph: { label: "Grafik", icon: <BarChart3 size={13} /> },
  severity_distribution: { label: "Severity Dağılımı", icon: <PieChart size={13} /> },
  problem_devices: { label: "Alarmlı Cihazlar", icon: <Server size={13} /> },
  top_n: { label: "Top N", icon: <GaugeIcon size={13} /> },
  platform_summary: { label: "Platform Özeti", icon: <Hash size={13} /> },
  service_health: { label: "Servis Sağlığı", icon: <Globe size={13} /> },
  escalation_history: { label: "Eskalasyon Geçmişi", icon: <Zap size={13} /> },
  maintenance_windows: { label: "Bakım Pencereleri", icon: <Clock size={13} /> },
  device_card: { label: "Cihaz Kartı", icon: <IdCard size={13} /> },
  status_badge: { label: "Durum Rozeti", icon: <Tag size={13} /> },
  raw_table: { label: "Ham Tablo", icon: <Table size={13} /> },
  note: { label: "Not", icon: <StickyNote size={13} /> },
  clock: { label: "Saat", icon: <Clock size={13} /> },
  url: { label: "URL", icon: <Link2 size={13} /> },
  gauge: { label: "Gösterge", icon: <GaugeIcon size={13} /> },
  pie_chart: { label: "Pasta Grafik", icon: <PieChart size={13} /> },
  device_explorer: { label: "Cihaz/Metrik Gezgini", icon: <Compass size={13} /> },
  status_grid: { label: "Durum Izgarası", icon: <Grid3x3 size={13} /> },
  web_monitoring_summary: { label: "Web İzleme Özeti", icon: <Wifi size={13} /> },
  host_performance_table: { label: "Host Performans Tablosu", icon: <Rows3 size={13} /> },
  vmware_cluster_summary: { label: "VMware Cluster Özeti", icon: <Server size={13} /> },
  vmware_datastore: { label: "VMware Datastore Kullanımı", icon: <HardDrive size={13} /> },
  vmware_vm_table: { label: "VMware VM Kaynak Kullanımı", icon: <Monitor size={13} /> },
  trap_log: { label: "SNMP Trap Günlüğü", icon: <RadioTower size={13} /> },
  syslog_log: { label: "Syslog Günlüğü", icon: <ScrollText size={13} /> }
};

// Yeni eklenen bir widget'ın başlangıç config'i — kullanıcı ekledikten hemen sonra
// çark ikonuyla açılan ayar panelinden (Faz 9.7) gerçek değerleri seçer.
const DEFAULT_CONFIG: Record<string, Record<string, any>> = {
  kpi_card: { source: "open_alerts" },
  problem_list: { limit: 5 },
  device_status: {},
  graph: {},
  severity_distribution: {},
  problem_devices: { limit: 10 },
  top_n: { limit: 5, order: "desc" },
  platform_summary: {},
  service_health: {},
  escalation_history: { limit: 10 },
  maintenance_windows: {},
  device_card: {},
  status_badge: {},
  raw_table: {},
  note: { text: "" },
  clock: {},
  url: { url: "" },
  gauge: { min: 0, max: 100 },
  pie_chart: { source: "severity_distribution" },
  device_explorer: {},
  status_grid: {},
  web_monitoring_summary: {},
  host_performance_table: { metrics: [] },
  vmware_cluster_summary: {},
  vmware_datastore: {},
  vmware_vm_table: {},
  trap_log: { limit: 20 },
  syslog_log: { limit: 20 }
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

export function DashboardGrid({ dashboardId, dashboardContext }: { dashboardId: string; dashboardContext?: DashboardContext }) {
  const { data: widgets, isLoading } = useDashboardWidgets(dashboardId);
  const bulkUpdate = useBulkUpdateWidgets(dashboardId);

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<EditableWidget[]>([]);
  const [showTypePicker, setShowTypePicker] = useState(false);

  // Hangi widget'ın ayar paneli açık (Faz 9.7) — aynı anda sadece bir tane açılabilir.
  const [expandedSettingsKey, setExpandedSettingsKey] = useState<string | null>(null);

  // Başlığın her zaman görünüp görünmeyeceği — DB'ye HİÇ yazılmaz, sadece bu oturum
  // için tutulur (Faz 9.10e). Belirtilmeyen widget'lar için varsayılan: her zaman görünür
  // (mevcut davranışla aynı, regresyon yok).
  const [titleAlwaysVisible, setTitleAlwaysVisible] = useState<Record<string, boolean>>({});

  function startEditing() {
    setDraft(toEditable(widgets || []));
    setIsEditing(true);
  }

  function cancelEditing() {
    setIsEditing(false);
    setDraft([]);
    setShowTypePicker(false);
    setExpandedSettingsKey(null);
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
        setExpandedSettingsKey(null);
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

  // BUG DÜZELTMESİ: panolar arası geçişte düzenleme modu/taslak/açık ayar paneli
  // önceki panodan sızıyordu (widgets verisi güncellendiği halde eski draft gösteriliyordu).
  // Pano değişince tüm yerel düzenleme state'i sıfırlanır.
  useEffect(() => {
    setIsEditing(false);
    setDraft([]);
    setShowTypePicker(false);
    setExpandedSettingsKey(null);
  }, [dashboardId]);

  function handleAddWidget(type: string) {
    const clientKey = nextTempKey();
    setDraft((prev) => [
      ...prev,
      {
        clientKey,
        widget_type: type as any,
        title: null,
        config: DEFAULT_CONFIG[type] || {},
        position_x: 0,
        position_y: Infinity, // react-grid-layout: Infinity = mevcut en alt satırın altına otomatik yerleş
        width: 4,
        height: 3
      }
    ]);
    setShowTypePicker(false);
    // Kullanıcı yeni widget'ı ekler eklemez ayar panelini otomatik aç — ham JSON
    // yazmak yerine doğrudan veri kaynağını seçsin.
    setExpandedSettingsKey(clientKey);
  }

  function handleRemoveWidget(clientKey: string) {
    setDraft((prev) => prev.filter((w) => w.clientKey !== clientKey));
    if (expandedSettingsKey === clientKey) setExpandedSettingsKey(null);
  }

  function handleApplySettings(clientKey: string, config: Record<string, any>, alwaysShowTitle: boolean) {
    setDraft((prev) => prev.map((w) => (w.clientKey === clientKey ? { ...w, config } : w)));
    setTitleAlwaysVisible((prev) => ({ ...prev, [clientKey]: alwaysShowTitle }));
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
            <div className="relative">
              <button
                onClick={() => setShowTypePicker((v) => !v)}
                className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg bg-[var(--text-accent)] text-white hover:opacity-90 transition-opacity shadow-sm"
              >
                <Plus size={16} />
                Widget ekle
              </button>
              {showTypePicker && (
                <div className="absolute right-0 top-full mt-1.5 bg-surface-2 border border-border rounded-xl shadow-md p-2 grid grid-cols-3 gap-1 z-10 w-80 max-h-72 overflow-y-auto">
                  {Object.entries(WIDGET_TYPE_META).map(([key, meta]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleAddWidget(key)}
                      className="flex flex-col items-center gap-1 px-1.5 py-2 rounded-lg border border-border text-[10px] text-text-secondary hover:bg-surface-1 hover:border-[var(--text-accent)] transition-colors"
                    >
                      {meta.icon}
                      {meta.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
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

      {displayWidgets.length > 0 ? (
        <GridLayout
          // BUG DÜZELTMESİ: react-grid-layout, isDraggable/isResizable prop değişikliklerini
          // her zaman iç state'ine doğru yansıtmıyor (bilinen kütüphane davranışı). Düzenleme
          // modu her açılıp kapandığında `key` değişince React'i TAM remount'a zorluyoruz —
          // aksi halde görüntüleme modunda bile sürükleme/boyutlandırma aktif kalabiliyordu.
          key={isEditing ? "edit" : "view"}
          className="layout"
          layout={layout}
          cols={12}
          rowHeight={60}
          onLayoutChange={isEditing ? (handleLayoutChange as any) : undefined}
          isDraggable={isEditing}
          isResizable={isEditing}
          isDroppable={false}
          static={!isEditing}
          draggableHandle={isEditing ? ".widget-drag-handle" : undefined}
          margin={[12, 12]}
        >
          {displayWidgets.map((widget) => {
            const meta = WIDGET_TYPE_META[widget.widget_type];
            const alwaysShowTitle = titleAlwaysVisible[widget.clientKey] ?? true;
            const isSettingsOpen = expandedSettingsKey === widget.clientKey;

            return (
              <div
                key={widget.clientKey}
                className="group bg-surface-2 border border-border rounded-2xl overflow-hidden flex flex-col shadow-sm hover:shadow-md transition-shadow"
              >
                <div
                  className={`flex items-center justify-between px-3 py-2 bg-surface-1/60 border-b border-border ${
                    isEditing ? "widget-drag-handle cursor-move" : ""
                  } ${alwaysShowTitle ? "" : "opacity-0 group-hover:opacity-100 transition-opacity"}`}
                >
                  <span className="flex items-center gap-1.5 text-[11px] text-text-secondary font-medium">
                    {meta?.icon}
                    {widget.title || meta?.label || widget.widget_type}
                    {usesDashboardContext(widget, dashboardContext) && (
                      <span
                        className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--bg-accent)] text-[var(--text-accent)] font-normal shrink-0"
                        title="Bu widget, panonun üstündeki 'Bağlam' çubuğunu takip ediyor"
                      >
                        <Link2 size={9} />
                        Pano
                      </span>
                    )}
                  </span>
                  {isEditing && (
                    // BUG DÜZELTMESİ: bu butonlar sürükleme tutamacının (widget-drag-handle)
                    // içinde olduğu için, react-grid-layout mousedown olayını sürükleme
                    // başlatıcısına kaptırıp tıklamayı engelliyordu. onMouseDown'da
                    // stopPropagation ile bu butonlara gelen mousedown'ın sürüklemeyi
                    // tetiklemesini önlüyoruz — onClick normal şekilde çalışmaya devam eder.
                    <div className="flex items-center gap-1" onMouseDown={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => setExpandedSettingsKey(isSettingsOpen ? null : widget.clientKey)}
                        className={`text-text-muted hover:text-text-accent ${isSettingsOpen ? "text-text-accent" : ""}`}
                        title="Widget ayarları"
                      >
                        <Settings2 size={13} />
                      </button>
                      <button
                        onClick={() => handleRemoveWidget(widget.clientKey)}
                        className="text-text-muted hover:text-[var(--text-danger)]"
                        title="Widget'ı sil"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}
                </div>
                <div className="flex-1 overflow-hidden">
                  {isSettingsOpen ? (
                    <WidgetSettingsPanel
                      widgetType={widget.widget_type}
                      config={widget.config}
                      alwaysShowTitle={alwaysShowTitle}
                      onApply={(config, always) => handleApplySettings(widget.clientKey, config, always)}
                      onClose={() => setExpandedSettingsKey(null)}
                    />
                  ) : (
                    <div className="h-full p-3 overflow-hidden">
                      <WidgetRenderer widget={widget as DashboardWidget} dashboardContext={dashboardContext} />
                    </div>
                  )}
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
          {isEditing ? (
            <div className="relative">
              {/* BUG DÜZELTMESİ: bu buton artık kendi picker'ını açmıyor — üstteki tek
                  "Widget ekle" picker'ını tetikliyor, aynı anda iki picker görünmesini önler. */}
              <button
                onClick={() => setShowTypePicker(true)}
                className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg bg-[var(--text-accent)] text-white hover:opacity-90"
              >
                <Plus size={15} />
                İlk widget'ı ekle
              </button>
              {false && (
                <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1.5 bg-surface-2 border border-border rounded-xl shadow-md p-2 grid grid-cols-3 gap-1 z-10 w-80 max-h-72 overflow-y-auto">
                  {Object.entries(WIDGET_TYPE_META).map(([key, meta]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleAddWidget(key)}
                      className="flex flex-col items-center gap-1 px-1.5 py-2 rounded-lg border border-border text-[10px] text-text-secondary hover:bg-surface-1 hover:border-[var(--text-accent)] transition-colors"
                    >
                      {meta.icon}
                      {meta.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={startEditing}
              className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg bg-[var(--text-accent)] text-white hover:opacity-90"
            >
              <Pencil size={15} />
              Düzenle
            </button>
          )}
        </div>
      )}
    </div>
  );
}
