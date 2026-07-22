import { useState, useEffect } from "react";
import { X } from "lucide-react";
import { useDevices } from "../devices/useDevices";
import { useMetricNames, useMetricNamesSummary } from "../devices/useMetrics";
import { useDeviceGroups } from "../deviceGroups/useDeviceGroups";
import { TIMELINE_COLORS } from "./widgets/GraphWidget";
import { useValueMaps } from "../valueMaps/useValueMaps";
import type { MetricSelection } from "../../api/metrics";

type WidgetType = "graph" | "problem_list" | "device_status" | "kpi_card" |
  "severity_distribution" | "problem_devices" | "top_n" | "platform_summary" |
  "service_health" | "escalation_history" | "maintenance_windows" |
  "device_card" | "status_badge" | "raw_table" | "note" | "clock" | "url" | "gauge" | "pie_chart" | "device_explorer" |
  "status_grid" | "web_monitoring_summary" | "host_performance_table" |
  "vmware_cluster_summary" | "vmware_datastore" | "vmware_vm_table" | "trap_log" | "syslog_log" |
  "predictive_forecast" | "alert_trend";

const KPI_SOURCES = [
  { value: "open_alerts", label: "Açık Alarmlar" },
  { value: "active_devices", label: "Aktif Cihazlar" },
  { value: "total_devices", label: "Toplam Cihaz" }
];

// Widget bileşenlerindeki (modules/dashboards/widgets/*.tsx) sabit kodlanmış
// refetchInterval değerleriyle AYNI seçenekler -- kullanıcı "Varsayılan"ı
// seçerse config.refresh_interval_seconds hiç yazılmaz, widget kendi sabit
// varsayılanını (çoğu 30sn, birkaçı 60sn) kullanmaya devam eder.
const REFRESH_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Varsayılan" },
  { value: "10", label: "10 saniye" },
  { value: "30", label: "30 saniye" },
  { value: "60", label: "1 dakika" },
  { value: "120", label: "2 dakika" },
  { value: "300", label: "5 dakika" },
  { value: "600", label: "10 dakika" },
  { value: "0", label: "Yenileme yok" }
];

function pillClass(active: boolean) {
  return `px-2.5 py-1 rounded-md border text-[11px] ${
    active ? "border-[var(--text-accent)] bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "border-border text-text-secondary"
  }`;
}

// Widget başlığındaki çark ikonuna basınca açılan ayar modal'ı. Önceden kart
// içinde widget'ın YERİNE geçen bir inline panel idi (Faz 9.7) -- artık her
// zaman görünen bir modal (EditDeviceModal.tsx'teki görsel dille AYNI), hem
// düzenleme modu hem normal görüntülemede açılabiliyor. Kaydetme davranışı
// (taslağa mı yoksa doğrudan API'ye mi yazılacağı) çağıran bileşende
// (DashboardGrid.tsx) karar veriliyor -- bu bileşen sadece onSave'i çağırır.
export function WidgetSettingsModal({
  widgetType,
  title,
  config,
  alwaysShowTitle,
  defaultLabel,
  onSave,
  onClose
}: {
  widgetType: WidgetType;
  title: string | null;
  config: Record<string, any>;
  alwaysShowTitle: boolean;
  defaultLabel: string;
  onSave: (title: string | null, config: Record<string, any>, alwaysShowTitle: boolean) => void;
  onClose: () => void;
}) {
  const [draftTitle, setDraftTitle] = useState(title ?? "");
  const [draftConfig, setDraftConfig] = useState<Record<string, any>>(config);
  const [draftAlwaysShowTitle, setDraftAlwaysShowTitle] = useState(alwaysShowTitle);

  useEffect(() => {
    setDraftTitle(title ?? "");
    setDraftConfig(config);
    setDraftAlwaysShowTitle(alwaysShowTitle);
  }, [title, config, alwaysShowTitle]);

  const { data: devicesData } = useDevices({ limit: 200 });
  const devices = devicesData?.items;
  const { data: deviceGroups } = useDeviceGroups();
  const { data: valueMaps } = useValueMaps();
  const { data: metricEntries } = useMetricNames(draftConfig.device_id);
  const uniqueMetrics = Array.from(new Set(metricEntries?.map((m) => m.metric_name) ?? []));
  // GERÇEK EKSİKLİK (kullanıcı bulundu): top_n/status_grid/host_performance_table
  // gibi bir host grubuna göre çalışan widget'larda metrik adı serbest metin
  // kutusuydu -- kullanıcı metrik adını ezberden yazmak zorundaydı. Bu, o
  // widget'ların ayarlarında (device_id yerine device_group_id kullanan) metrik
  // dropdown'ı için.
  const { data: groupMetricNames } = useMetricNamesSummary(draftConfig.device_group_id);

  const selectedMetrics: MetricSelection[] =
    Array.isArray(draftConfig.metrics) && draftConfig.metrics.length > 0
      ? draftConfig.metrics
      : draftConfig.metric_name
      ? [{ metric_name: draftConfig.metric_name }]
      : [];

  const firstSelectedMeta = selectedMetrics[0] ? metricEntries?.find((m) => m.metric_name === selectedMetrics[0].metric_name) : undefined;

  const availableMetricOptions = uniqueMetrics
    .filter((m) => !selectedMetrics.some((sel) => sel.metric_name === m))
    .map((m) => {
      const meta = metricEntries?.find((e) => e.metric_name === m);
      const compatible =
        !firstSelectedMeta ||
        ((meta?.data_type ?? "gauge") === (firstSelectedMeta.data_type ?? "gauge") && !!meta?.is_table === !!firstSelectedMeta.is_table);
      return { metric_name: m, compatible };
    });

  function addMetric(metricName: string) {
    const next = [...selectedMetrics, { metric_name: metricName, color: TIMELINE_COLORS[selectedMetrics.length % TIMELINE_COLORS.length] }];
    setDraftConfig((prev) => {
      const { metric_name, ...rest } = prev;
      return { ...rest, metrics: next };
    });
  }

  function removeMetric(metricName: string) {
    const next = selectedMetrics.filter((m) => m.metric_name !== metricName);
    setDraftConfig((prev) => ({ ...prev, metrics: next }));
  }

  // Kullanıcı isteği: her serinin çizim stili/kalınlık/dolgu/eksen ayarı --
  // Zabbix'in gelişmiş grafik editöründeki "Data set" satırlarıyla AYNI fikir.
  function updateMetric(metricName: string, patch: Partial<MetricSelection>) {
    const next = selectedMetrics.map((s) => (s.metric_name === metricName ? { ...s, ...patch } : s));
    setDraftConfig((prev) => ({ ...prev, metrics: next }));
  }

  function update(field: string, value: any) {
    setDraftConfig((prev) => ({ ...prev, [field]: value }));
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    onSave(draftTitle.trim() || null, draftConfig, draftAlwaysShowTitle);
  }

  const graphUsesDashboard = draftConfig.device_source === "dashboard";
  const deviceStatusUsesDashboard = draftConfig.group_source === "dashboard";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <form
        onSubmit={handleSave}
        onClick={(e) => e.stopPropagation()}
        className="bg-surface-2 border border-border rounded-xl p-5 w-[480px] max-h-[85vh] overflow-y-auto flex flex-col gap-3 text-xs"
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-medium">Widget ayarları</h2>
          <button type="button" onClick={onClose} className="text-text-muted"><X size={18} /></button>
        </div>

        <label className="text-text-secondary">
          Widget adı
          <input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder={defaultLabel}
            className="mt-1 w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
          />
        </label>

        <label className="text-text-secondary">
          Yenilenme süresi
          <select
            value={draftConfig.refresh_interval_seconds !== undefined ? String(draftConfig.refresh_interval_seconds) : ""}
            onChange={(e) => update("refresh_interval_seconds", e.target.value === "" ? undefined : Number(e.target.value))}
            className="mt-1 w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
          >
            {REFRESH_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>

        <div>
          <p className="font-medium text-text-secondary mb-1.5">Veri kaynağı</p>
          <div className="flex flex-col gap-2">
            {widgetType === "graph" && (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="text-text-muted shrink-0 mr-1">Cihaz:</span>
                  <button type="button" onClick={() => update("device_source", "dashboard")} className={pillClass(graphUsesDashboard)}>
                    Pano
                  </button>
                  <button type="button" onClick={() => update("device_source", "custom")} className={pillClass(!graphUsesDashboard)}>
                    Özel
                  </button>
                </div>

                {graphUsesDashboard ? (
                  <>
                    <p className="text-[10px] text-text-muted">Bu widget, panonun üstündeki bağlam seçicisindeki cihazı ve zaman aralığını kullanır.</p>
                    <input
                      value={draftConfig.metric_name || ""}
                      onChange={(e) => update("metric_name", e.target.value)}
                      placeholder="Metrik adı (örn. cpu_load_1min)"
                      className="px-2 py-1.5 rounded-md border border-border bg-surface-1"
                    />
                  </>
                ) : (
                  <>
                    <select
                      value={draftConfig.device_id || ""}
                      onChange={(e) => setDraftConfig((prev) => ({ ...prev, device_id: e.target.value, metrics: [], metric_name: undefined }))}
                      className="px-2 py-1.5 rounded-md border border-border bg-surface-1"
                    >
                      <option value="">Cihaz seç</option>
                      {devices?.map((d) => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>

                    <div className="flex flex-col gap-1.5">
                      <span className="text-text-muted">Metrikler</span>
                      {selectedMetrics.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          {selectedMetrics.map((sel, i) => (
                            <div key={sel.metric_name} className="flex flex-col gap-1.5 p-1.5 rounded-md bg-surface-1 border border-border">
                              <div className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: sel.color || TIMELINE_COLORS[i % TIMELINE_COLORS.length] }} />
                                <span className="flex-1 truncate">{sel.metric_name}</span>
                                <button type="button" onClick={() => removeMetric(sel.metric_name)} className="text-text-muted hover:text-[var(--text-danger)]">
                                  <X size={11} />
                                </button>
                              </div>
                              {/* Kullanıcı isteği: Zabbix'in gelişmiş grafik editöründeki
                                  "Draw/Width/Fill/Y-axis" alanlarıyla AYNI fikir -- her
                                  serinin kendi çizim stili/kalınlık/dolgu/ekseni. */}
                              <div className="flex items-center gap-1 flex-wrap">
                                <select
                                  value={sel.drawStyle || "line"}
                                  onChange={(e) => updateMetric(sel.metric_name, { drawStyle: e.target.value as MetricSelection["drawStyle"] })}
                                  className="text-[10px] px-1 py-0.5 rounded border border-border bg-surface-2"
                                  title="Çizim stili"
                                >
                                  <option value="line">Çizgi</option>
                                  <option value="points">Nokta</option>
                                  <option value="staircase">Basamak</option>
                                </select>
                                <input
                                  type="number" min={1} max={5} step={0.5}
                                  value={sel.width ?? 1.5}
                                  onChange={(e) => updateMetric(sel.metric_name, { width: Number(e.target.value) })}
                                  title="Kalınlık"
                                  className="w-11 text-[10px] px-1 py-0.5 rounded border border-border bg-surface-2"
                                />
                                <input
                                  type="number" min={0} max={100}
                                  value={sel.fillOpacity ?? 0}
                                  onChange={(e) => updateMetric(sel.metric_name, { fillOpacity: Number(e.target.value) })}
                                  title="Dolgu (%)"
                                  className="w-12 text-[10px] px-1 py-0.5 rounded border border-border bg-surface-2"
                                />
                                <button
                                  type="button"
                                  onClick={() => updateMetric(sel.metric_name, { yAxis: sel.yAxis === "right" ? "left" : "right" })}
                                  title="Y ekseni"
                                  className={`text-[10px] px-1.5 py-0.5 rounded border ${sel.yAxis === "right" ? "border-[var(--text-accent)] text-[var(--text-accent)]" : "border-border text-text-muted"}`}
                                >
                                  {sel.yAxis === "right" ? "Sağ eksen" : "Sol eksen"}
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      <select
                        value=""
                        onChange={(e) => {
                          if (e.target.value) addMetric(e.target.value);
                        }}
                        disabled={!draftConfig.device_id}
                        className="px-2 py-1.5 rounded-md border border-border bg-surface-1 disabled:opacity-50"
                      >
                        <option value="">+ Metrik ekle</option>
                        {availableMetricOptions.map((m) => (
                          <option key={m.metric_name} value={m.metric_name} disabled={!m.compatible}>
                            {m.metric_name}
                            {!m.compatible ? " — farklı veri tipi, eklenemez" : ""}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-text-muted shrink-0">Zaman aralığı:</span>
                      <select value={draftConfig.hours || 6} onChange={(e) => update("hours", Number(e.target.value))} className="px-2 py-1 rounded-md border border-border bg-surface-1">
                        <option value={1}>1 saat</option>
                        <option value={6}>6 saat</option>
                        <option value={24}>24 saat</option>
                        <option value={168}>7 gün</option>
                      </select>
                    </div>
                  </>
                )}
              </>
            )}

            {widgetType === "kpi_card" && (
              <select value={draftConfig.source || "open_alerts"} onChange={(e) => update("source", e.target.value)} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
                {KPI_SOURCES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            )}

            {widgetType === "problem_list" && (
              <div className="flex flex-col gap-2">
                <select value={draftConfig.device_group_id || ""} onChange={(e) => update("device_group_id", e.target.value || undefined)} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
                  <option value="">Tüm cihazlar</option>
                  {deviceGroups?.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
                <div className="flex items-center gap-2">
                  <span className="text-text-muted shrink-0">Gösterilecek alarm sayısı:</span>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={draftConfig.limit || 5}
                    onChange={(e) => update("limit", Number(e.target.value))}
                    className="w-16 px-2 py-1 rounded-md border border-border bg-surface-1"
                  />
                </div>
              </div>
            )}

            {widgetType === "device_status" && (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="text-text-muted shrink-0 mr-1">Cihaz grubu:</span>
                  <button type="button" onClick={() => update("group_source", "dashboard")} className={pillClass(deviceStatusUsesDashboard)}>
                    Pano
                  </button>
                  <button type="button" onClick={() => update("group_source", "custom")} className={pillClass(!deviceStatusUsesDashboard)}>
                    Özel
                  </button>
                </div>
                {deviceStatusUsesDashboard ? (
                  <p className="text-[10px] text-text-muted">Bu widget, panonun üstündeki bağlam seçicisindeki host grubunu kullanır.</p>
                ) : (
                  <select value={draftConfig.device_group_id || ""} onChange={(e) => update("device_group_id", e.target.value || undefined)} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
                    <option value="">Tüm cihazlar</option>
                    {deviceGroups?.map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                )}
              </>
            )}
            {(widgetType === "severity_distribution" || widgetType === "problem_devices" || widgetType === "predictive_forecast" || widgetType === "alert_trend") && (
              <select value={draftConfig.device_group_id || ""} onChange={(e) => update("device_group_id", e.target.value || undefined)} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
                <option value="">Tüm cihazlar</option>
                {deviceGroups?.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            )}
            {widgetType === "problem_devices" && (
              <div className="flex items-center gap-2 mt-2">
                <span className="text-text-muted shrink-0">Gösterilecek cihaz sayısı:</span>
                <input type="number" min={1} max={50} value={draftConfig.limit || 10} onChange={(e) => update("limit", Number(e.target.value))} className="w-16 px-2 py-1 rounded-md border border-border bg-surface-1" />
              </div>
            )}
            {widgetType === "predictive_forecast" && (
              <div className="flex items-center gap-2 mt-2">
                <span className="text-text-muted shrink-0">Gösterilecek tahmin sayısı:</span>
                <input type="number" min={1} max={50} value={draftConfig.limit || 10} onChange={(e) => update("limit", Number(e.target.value))} className="w-16 px-2 py-1 rounded-md border border-border bg-surface-1" />
              </div>
            )}
            {widgetType === "alert_trend" && (
              <div className="flex items-center gap-2 mt-2">
                <span className="text-text-muted shrink-0">Zaman aralığı:</span>
                <select value={draftConfig.hours || 24} onChange={(e) => update("hours", Number(e.target.value))} className="px-2 py-1 rounded-md border border-border bg-surface-1">
                  <option value={24}>24 saat</option>
                  <option value={168}>7 gün</option>
                  <option value={720}>30 gün</option>
                </select>
              </div>
            )}
            {widgetType === "top_n" && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-text-muted shrink-0">Metrik adı:</span>
                  <select value={draftConfig.metric_name || ""} onChange={(e) => update("metric_name", e.target.value)} className="flex-1 px-2 py-1.5 rounded-md border border-border bg-surface-1">
                    <option value="">Metrik seç</option>
                    {groupMetricNames?.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <select value={draftConfig.device_group_id || ""} onChange={(e) => update("device_group_id", e.target.value || undefined)} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
                  <option value="">Tüm cihazlar</option>
                  {deviceGroups?.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
                <div className="flex items-center gap-2">
                  <span className="text-text-muted shrink-0">Sayı:</span>
                  <input type="number" min={1} max={20} value={draftConfig.limit || 5} onChange={(e) => update("limit", Number(e.target.value))} className="w-16 px-2 py-1 rounded-md border border-border bg-surface-1" />
                  <select value={draftConfig.order || "desc"} onChange={(e) => update("order", e.target.value)} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
                    <option value="desc">En yüksek</option>
                    <option value="asc">En düşük</option>
                  </select>
                </div>
              </div>
            )}
            {widgetType === "service_health" && (
              <div className="flex items-center gap-2">
                <span className="text-text-muted shrink-0">Web Senaryosu ID:</span>
                <input value={draftConfig.web_scenario_id || ""} onChange={(e) => update("web_scenario_id", e.target.value)} placeholder="Web Senaryosu detay sayfasından kopyala" className="flex-1 px-2 py-1 rounded-md border border-border bg-surface-1" />
              </div>
            )}
            {(widgetType === "escalation_history" || widgetType === "platform_summary" || widgetType === "maintenance_windows" || widgetType === "web_monitoring_summary") && (
              <p className="text-[10px] text-text-muted">Bu widget ek ayar gerektirmiyor.</p>
            )}
            {(widgetType === "device_card" || widgetType === "status_badge" || widgetType === "raw_table" || widgetType === "gauge") && (
              <div className="flex flex-col gap-2">
                <select value={draftConfig.device_id || ""} onChange={(e) => update("device_id", e.target.value || undefined)} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
                  <option value="">Cihaz seç</option>
                  {devices?.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
                {widgetType !== "device_card" && (
                  <select
                    value={draftConfig.metric_name || ""}
                    onChange={(e) => update("metric_name", e.target.value)}
                    disabled={!draftConfig.device_id}
                    className="px-2 py-1.5 rounded-md border border-border bg-surface-1 disabled:opacity-50"
                  >
                    <option value="">{draftConfig.device_id ? "Metrik seç" : "Önce cihaz seçin"}</option>
                    {uniqueMetrics.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                )}
                {widgetType === "gauge" && (
                  <div className="flex items-center gap-2">
                    <span className="text-text-muted shrink-0">Min/Max:</span>
                    <input type="number" value={draftConfig.min ?? 0} onChange={(e) => update("min", Number(e.target.value))} className="w-16 px-2 py-1 rounded-md border border-border bg-surface-1" />
                    <input type="number" value={draftConfig.max ?? 100} onChange={(e) => update("max", Number(e.target.value))} className="w-16 px-2 py-1 rounded-md border border-border bg-surface-1" />
                  </div>
                )}
              </div>
            )}
            {widgetType === "note" && (
              <textarea value={draftConfig.text || ""} onChange={(e) => update("text", e.target.value)} placeholder="Metin/not..." className="w-full h-20 px-2 py-1.5 rounded-md border border-border bg-surface-1" />
            )}
            {widgetType === "url" && (
              <input value={draftConfig.url || ""} onChange={(e) => update("url", e.target.value)} placeholder="https://..." className="w-full px-2 py-1.5 rounded-md border border-border bg-surface-1" />
            )}
            {(widgetType === "clock" || widgetType === "device_explorer") && (
              <p className="text-[10px] text-text-muted">Bu widget ek ayar gerektirmiyor.</p>
            )}
            {widgetType === "pie_chart" && (
              <select value={draftConfig.device_group_id || ""} onChange={(e) => update("device_group_id", e.target.value || undefined)} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
                <option value="">Tüm cihazlar</option>
                {deviceGroups?.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            )}
            {(widgetType === "vmware_cluster_summary" || widgetType === "vmware_datastore") && (
              <div className="flex flex-col gap-1.5">
                <span className="text-text-muted">vCenter/ESXi cihazı</span>
                <select value={draftConfig.device_id || ""} onChange={(e) => update("device_id", e.target.value || undefined)} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
                  <option value="">Cihaz seç</option>
                  {devicesData?.items?.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            )}
            {widgetType === "vmware_vm_table" && (
              <div className="flex flex-col gap-1.5">
                <span className="text-text-muted">Host grubu (örn. "&lt;vCenter&gt; - Tüm Host'lar")</span>
                <select value={draftConfig.device_group_id || ""} onChange={(e) => update("device_group_id", e.target.value || undefined)} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
                  <option value="">Grup seç</option>
                  {deviceGroups?.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </div>
            )}
            {widgetType === "trap_log" && (
              <select value={draftConfig.device_group_id || ""} onChange={(e) => update("device_group_id", e.target.value || undefined)} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
                <option value="">Tüm cihazlar</option>
                {deviceGroups?.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            )}
            {widgetType === "syslog_log" && (
              <div className="flex flex-col gap-2">
                <select value={draftConfig.device_group_id || ""} onChange={(e) => update("device_group_id", e.target.value || undefined)} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
                  <option value="">Tüm cihazlar</option>
                  {deviceGroups?.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
                <div className="flex flex-col gap-1.5">
                  <span className="text-text-muted">En düşük ciddiyet (bu ve daha ciddi olanlar)</span>
                  <select value={draftConfig.min_severity ?? ""} onChange={(e) => update("min_severity", e.target.value === "" ? undefined : Number(e.target.value))} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
                    <option value="">Tümü (filtre yok)</option>
                    <option value="0">emerg</option>
                    <option value="1">alert ve üstü</option>
                    <option value="2">crit ve üstü</option>
                    <option value="3">err ve üstü</option>
                    <option value="4">warning ve üstü</option>
                    <option value="5">notice ve üstü</option>
                    <option value="6">info ve üstü</option>
                  </select>
                </div>
              </div>
            )}
            {widgetType === "host_performance_table" && (
              <div className="flex flex-col gap-2">
                <select value={draftConfig.device_group_id || ""} onChange={(e) => update("device_group_id", e.target.value || undefined)} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
                  <option value="">Tüm cihazlar (en fazla 25)</option>
                  {deviceGroups?.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
                <div className="flex flex-col gap-1.5">
                  <span className="text-text-muted">Metrikler (en fazla 5)</span>
                  {(draftConfig.metrics || []).length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {(draftConfig.metrics as string[]).map((m: string) => (
                        <span key={m} className="flex items-center gap-1 px-2 py-1 rounded-full bg-surface-1 border border-border">
                          {m}
                          <button
                            type="button"
                            onClick={() => update("metrics", (draftConfig.metrics as string[]).filter((x) => x !== m))}
                            className="text-text-muted hover:text-[var(--text-danger)]"
                          >
                            <X size={11} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <select
                    value=""
                    onChange={(e) => {
                      const current: string[] = draftConfig.metrics || [];
                      if (e.target.value && current.length < 5) {
                        update("metrics", [...current, e.target.value]);
                      }
                    }}
                    disabled={(draftConfig.metrics || []).length >= 5}
                    className="px-2 py-1.5 rounded-md border border-border bg-surface-1 disabled:opacity-50"
                  >
                    <option value="">+ Metrik ekle</option>
                    {groupMetricNames
                      ?.filter((m) => !(draftConfig.metrics || []).includes(m))
                      .map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                {/* Kullanıcı isteği: ilk (ana) metrik artık gradyan bar olarak
                    gösteriliyor -- gauge widget'ındaki min/max konvansiyonuyla AYNI. */}
                <div className="flex items-center gap-2">
                  <span className="text-text-muted shrink-0">İlk metrik ölçeği (bar için) Min/Max:</span>
                  <input type="number" value={draftConfig.min ?? 0} onChange={(e) => update("min", Number(e.target.value))} className="w-16 px-2 py-1 rounded-md border border-border bg-surface-1" />
                  <input type="number" value={draftConfig.max ?? 100} onChange={(e) => update("max", Number(e.target.value))} className="w-16 px-2 py-1 rounded-md border border-border bg-surface-1" />
                </div>
              </div>
            )}
            {widgetType === "status_grid" && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-text-muted shrink-0">Metrik adı:</span>
                  <select value={draftConfig.metric_name || ""} onChange={(e) => update("metric_name", e.target.value)} className="flex-1 px-2 py-1.5 rounded-md border border-border bg-surface-1">
                    <option value="">Metrik seç</option>
                    {groupMetricNames?.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <select value={draftConfig.device_group_id || ""} onChange={(e) => update("device_group_id", e.target.value || undefined)} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
                  <option value="">Tüm cihazlar</option>
                  {deviceGroups?.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
                <select value={draftConfig.value_map_id || ""} onChange={(e) => update("value_map_id", e.target.value || undefined)} className="px-2 py-1.5 rounded-md border border-border bg-surface-1">
                  <option value="">Değer haritası yok (eşiğe göre renklendir)</option>
                  {valueMaps?.map((vm) => (
                    <option key={vm.id} value={vm.id}>{vm.name}</option>
                  ))}
                </select>
                {!draftConfig.value_map_id && (
                  <div className="flex items-center gap-2">
                    <span className="text-text-muted shrink-0">İyi ≤ / Kritik ≥:</span>
                    <input type="number" value={draftConfig.good_max ?? ""} onChange={(e) => update("good_max", e.target.value === "" ? undefined : Number(e.target.value))} placeholder="ör. 50" className="w-16 px-2 py-1 rounded-md border border-border bg-surface-1" />
                    <input type="number" value={draftConfig.critical_min ?? ""} onChange={(e) => update("critical_min", e.target.value === "" ? undefined : Number(e.target.value))} placeholder="ör. 100" className="w-16 px-2 py-1 rounded-md border border-border bg-surface-1" />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div>
          <p className="font-medium text-text-secondary mb-1.5">Görünüm</p>
          <label className="flex items-center gap-2 text-text-secondary">
            <input type="checkbox" checked={draftAlwaysShowTitle} onChange={(e) => setDraftAlwaysShowTitle(e.target.checked)} />
            Başlığı her zaman göster (kapalıysa sadece üzerine gelince görünür)
          </label>
        </div>

        <div className="flex items-center gap-2 justify-end pt-1 mt-auto">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-text-secondary hover:bg-surface-1">
            İptal
          </button>
          <button type="submit" className="px-3 py-1.5 rounded-md bg-[var(--text-accent)] text-white">
            Kaydet
          </button>
        </div>
      </form>
    </div>
  );
}
