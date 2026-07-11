import { useState, useEffect } from "react";
import { X } from "lucide-react";
import { useDevices } from "../devices/useDevices";
import { useMetricNames } from "../devices/useMetrics";
import { useDeviceGroups } from "../deviceGroups/useDeviceGroups";
import { TIMELINE_COLORS } from "./widgets/GraphWidget";
import type { MetricSelection } from "../../api/metrics";

type WidgetType = "graph" | "problem_list" | "device_status" | "kpi_card" |
  "severity_distribution" | "problem_devices" | "top_n" | "platform_summary" |
  "service_health" | "escalation_history" | "maintenance_windows" |
  "device_card" | "status_badge" | "raw_table" | "note" | "clock" | "url" | "gauge" | "pie_chart";

const KPI_SOURCES = [
  { value: "open_alerts", label: "Açık Alarmlar" },
  { value: "active_devices", label: "Aktif Cihazlar" },
  { value: "total_devices", label: "Toplam Cihaz" }
];

function pillClass(active: boolean) {
  return `px-2.5 py-1 rounded-md border text-[11px] ${
    active ? "border-[var(--text-accent)] bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "border-border text-text-secondary"
  }`;
}

// Widget başlığındaki çark ikonuna basınca kart içinde açılan ayar paneli (Faz 9.7).
// "Uygula" burada SADECE yerel taslağı günceller — API'ye hiç dokunmaz, gerçek kayıt
// panonun üstündeki "Kaydet"te olur (bkz. Faz 9.6/9.10a). Görünüm ayarları (başlık
// görünürlüğü) DB'ye hiç yazılmaz, sadece bu oturum için React state'te tutulur (9.10e).
export function WidgetSettingsPanel({
  widgetType,
  config,
  alwaysShowTitle,
  onApply,
  onClose
}: {
  widgetType: WidgetType;
  config: Record<string, any>;
  alwaysShowTitle: boolean;
  onApply: (config: Record<string, any>, alwaysShowTitle: boolean) => void;
  onClose: () => void;
}) {
  const [draftConfig, setDraftConfig] = useState<Record<string, any>>(config);
  const [draftAlwaysShowTitle, setDraftAlwaysShowTitle] = useState(alwaysShowTitle);

  useEffect(() => {
    setDraftConfig(config);
    setDraftAlwaysShowTitle(alwaysShowTitle);
  }, [config, alwaysShowTitle]);

  const { data: devicesData } = useDevices({ limit: 200 });
  const devices = devicesData?.items;
  const { data: deviceGroups } = useDeviceGroups();
  const { data: metricEntries } = useMetricNames(draftConfig.device_id);
  const uniqueMetrics = Array.from(new Set(metricEntries?.map((m) => m.metric_name) ?? []));

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

  function update(field: string, value: any) {
    setDraftConfig((prev) => ({ ...prev, [field]: value }));
  }

  function handleApply() {
    onApply(draftConfig, draftAlwaysShowTitle);
    onClose();
  }

  const graphUsesDashboard = draftConfig.device_source === "dashboard";
  const deviceStatusUsesDashboard = draftConfig.group_source === "dashboard";

  return (
    <div className="p-3 flex flex-col gap-3 text-xs h-full overflow-y-auto">
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
                      <div className="flex flex-wrap gap-1.5">
                        {selectedMetrics.map((sel, i) => (
                          <span key={sel.metric_name} className="flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full bg-surface-1 border border-border">
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: sel.color || TIMELINE_COLORS[i % TIMELINE_COLORS.length] }} />
                            <span className="truncate max-w-[120px]">{sel.metric_name}</span>
                            <button type="button" onClick={() => removeMetric(sel.metric_name)} className="text-text-muted hover:text-[var(--text-danger)]">
                              <X size={11} />
                            </button>
                          </span>
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
          {(widgetType === "severity_distribution" || widgetType === "problem_devices") && (
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
          {widgetType === "top_n" && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-text-muted shrink-0">Metrik adı:</span>
                <input value={draftConfig.metric_name || ""} onChange={(e) => update("metric_name", e.target.value)} placeholder="örn. memory_used_percent" className="flex-1 px-2 py-1 rounded-md border border-border bg-surface-1" />
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
          {(widgetType === "escalation_history" || widgetType === "platform_summary" || widgetType === "maintenance_windows") && (
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
                <input value={draftConfig.metric_name || ""} onChange={(e) => update("metric_name", e.target.value)} placeholder="metrik adı" className="px-2 py-1.5 rounded-md border border-border bg-surface-1" />
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
          {widgetType === "clock" && (
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
        <button type="button" onClick={handleApply} className="px-3 py-1.5 rounded-md bg-[var(--text-accent)] text-white">
          Uygula
        </button>
      </div>
    </div>
  );
}
