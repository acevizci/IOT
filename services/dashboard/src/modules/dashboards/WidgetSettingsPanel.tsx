import { useState, useEffect } from "react";
import { useDevices } from "../devices/useDevices";
import { useMetricNames } from "../devices/useMetrics";
import { useDeviceGroups } from "../deviceGroups/useDeviceGroups";

type WidgetType = "graph" | "problem_list" | "device_status" | "kpi_card";

const KPI_SOURCES = [
  { value: "open_alerts", label: "Açık Alarmlar" },
  { value: "active_devices", label: "Aktif Cihazlar" },
  { value: "total_devices", label: "Toplam Cihaz" }
];

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

  function update(field: string, value: any) {
    setDraftConfig((prev) => ({ ...prev, [field]: value }));
  }

  function handleApply() {
    onApply(draftConfig, draftAlwaysShowTitle);
    onClose();
  }

  return (
    <div className="p-3 flex flex-col gap-3 text-xs h-full overflow-y-auto">
      <div>
        <p className="font-medium text-text-secondary mb-1.5">Veri kaynağı</p>
        <div className="flex flex-col gap-2">
          {widgetType === "graph" && (
            <>
              <select
                value={draftConfig.device_id || ""}
                onChange={(e) => setDraftConfig((prev) => ({ ...prev, device_id: e.target.value, metric_name: undefined }))}
                className="px-2 py-1.5 rounded-md border border-border bg-surface-1"
              >
                <option value="">Cihaz seç</option>
                {devices?.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
              <select
                value={draftConfig.metric_name || ""}
                onChange={(e) => update("metric_name", e.target.value)}
                disabled={!draftConfig.device_id}
                className="px-2 py-1.5 rounded-md border border-border bg-surface-1 disabled:opacity-50"
              >
                <option value="">Metrik seç</option>
                {uniqueMetrics.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
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
