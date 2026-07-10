import { useQueries } from "@tanstack/react-query";
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { useMetricNames } from "../../devices/useMetrics";
import { useValueMaps } from "../../valueMaps/useValueMaps";
import { fetchMetrics } from "../../../api/metrics";
import type { ValueMap } from "../../../api/valueMaps";
import type { MetricPoint, MetricSelection } from "../../../api/metrics";

// Durum zaman çizelgesi ve çoklu-satır/çoklu-metrik grafiklerde döngüsel olarak
// kullanılan sabit palet. WidgetSettingsPanel'in çip renkleri de bununla tutarlı olsun
// diye export ediliyor.
export const TIMELINE_COLORS = ["#378ADD", "#D85A30", "#4CAF50", "#F2A93B", "#9C6ADE", "#E85D9C", "#4FB3BF", "#C77D3A"];

function formatAxisValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}G`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

// Faz 9.10h — geriye dönük uyumluluk: 9.2 öncesi widget'lar {metric_name: "..."}
// kullanıyordu, yeni config {metrics: [{metric_name, color}]} kullanıyor. Ayrı bir veri
// migration'ı gerekmiyor — eski format burada tek elemanlı bir diziye çevriliyor.
function resolveMetricSelections(config: Record<string, any>): MetricSelection[] {
  if (Array.isArray(config.metrics) && config.metrics.length > 0) return config.metrics;
  if (config.metric_name) return [{ metric_name: config.metric_name }];
  return [];
}

export function GraphWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const deviceId = config.device_id;
  const hours = config.hours || 6;
  const selections = resolveMetricSelections(config);

  const { data: metricEntries } = useMetricNames(deviceId);
  const { data: valueMaps } = useValueMaps();

  const metricQueries = useQueries({
    queries: selections.map((sel) => ({
      queryKey: ["metrics", deviceId, sel.metric_name, hours],
      queryFn: () => fetchMetrics(deviceId, sel.metric_name, hours),
      enabled: !!deviceId && !!sel.metric_name,
      refetchInterval: 30000
    }))
  });

  if (!deviceId || selections.length === 0) {
    return <p className="text-xs text-text-muted p-2">Widget ayarlarında cihaz/metrik seçilmemiş.</p>;
  }

  const isLoading = metricQueries.some((q) => q.isLoading);
  if (isLoading) return <p className="text-xs text-text-muted p-2">Yükleniyor...</p>;

  const metaFor = (metricName: string) => metricEntries?.find((m) => m.metric_name === metricName);
  const firstMeta = metaFor(selections[0].metric_name);

  // Faz 9.10b — çoklu metrik seçimi sadece hepsi "basit" (tablo/durum-haritası olmayan
  // tekil seri) tipteyse tek grafikte anlamlı şekilde birleştirilebilir. Bu koşul
  // sağlanmıyorsa (örn. kullanıcı yine de uyumsuz bir eski config'e sahipse), sadece
  // ilk metriği Faz 9.1'in tekil-metrik render mantığıyla gösteririz.
  const allSimpleGauge = selections.every((sel) => {
    const m = metaFor(sel.metric_name);
    return (m?.data_type ?? "gauge") === "gauge" && !m?.is_table && !m?.value_map_id;
  });

  if (selections.length > 1 && allSimpleGauge) {
    const byTime = new Map<string, Record<string, any>>();
    metricQueries.forEach((q, i) => {
      const rows = q.data?.rows ?? [];
      for (const row of rows) {
        if (!byTime.has(row.time)) byTime.set(row.time, { time: row.time });
        byTime.get(row.time)![selections[i].metric_name] = row.value;
      }
    });
    const chartData = Array.from(byTime.values()).sort((a, b) => (a.time > b.time ? 1 : -1));

    return (
      <div className="h-full flex flex-col">
        <p className="text-xs text-text-secondary mb-1">{title || "Grafik"}</p>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <XAxis dataKey="time" hide />
            <YAxis width={38} tick={{ fontSize: 10 }} tickFormatter={formatAxisValue} />
            <Tooltip labelFormatter={(v) => new Date(v).toLocaleString("tr-TR")} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            {selections.map((sel, i) => (
              <Line
                key={sel.metric_name}
                type="monotone"
                dataKey={sel.metric_name}
                stroke={sel.color || TIMELINE_COLORS[i % TIMELINE_COLORS.length]}
                dot={false}
                strokeWidth={1.5}
                name={sel.metric_name}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // Tekil metrik (ya da birleştirilemeyen çoklu seçimde sadece ilki) — Faz 9.1'in
  // veri tipine duyarlı render mantığı burada aynen devam ediyor.
  const singleMetricName = selections[0].metric_name;
  const singleRows = metricQueries[0]?.data?.rows ?? [];
  const dataType = firstMeta?.data_type ?? "gauge";
  const isTable = firstMeta?.is_table ?? false;
  const valueMapId = firstMeta?.value_map_id ?? null;
  const valueMap = valueMapId ? valueMaps?.find((vm) => vm.id === valueMapId) : undefined;

  if (dataType === "string") {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center gap-1">
        <p className="text-xs text-text-secondary">{title || singleMetricName}</p>
        <p className="text-xs text-text-muted">Bu metrik metin tipinde — grafikte gösterilemez.</p>
      </div>
    );
  }

  if (valueMap && isTable) {
    const interfaces = Array.from(new Set(singleRows.map((r) => r.interface).filter(Boolean))) as string[];
    return (
      <div className="h-full flex flex-col gap-2 overflow-y-auto">
        <p className="text-xs text-text-secondary">{title || singleMetricName}</p>
        {interfaces.length === 0 && <p className="text-xs text-text-muted">Veri yok.</p>}
        {interfaces.map((iface) => (
          <div key={iface}>
            <p className="text-[10px] text-text-muted mb-0.5">{iface}</p>
            <StatusTimeline rows={singleRows.filter((r) => r.interface === iface)} valueMap={valueMap} />
          </div>
        ))}
      </div>
    );
  }

  if (valueMap) {
    return (
      <div className="h-full flex flex-col justify-center">
        <p className="text-xs text-text-secondary mb-2">{title || singleMetricName}</p>
        <StatusTimeline rows={singleRows} valueMap={valueMap} showLatest />
      </div>
    );
  }

  if (isTable) {
    const interfaces = Array.from(new Set(singleRows.map((r) => r.interface).filter(Boolean))) as string[];
    const byTime = new Map<string, Record<string, any>>();
    for (const row of singleRows) {
      if (!byTime.has(row.time)) byTime.set(row.time, { time: row.time });
      byTime.get(row.time)![row.interface || "değer"] = row.value;
    }
    const chartData = Array.from(byTime.values()).sort((a, b) => (a.time > b.time ? 1 : -1));

    return (
      <div className="h-full flex flex-col">
        <p className="text-xs text-text-secondary mb-1">{title || singleMetricName}</p>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <XAxis dataKey="time" hide />
            <YAxis width={38} tick={{ fontSize: 10 }} tickFormatter={formatAxisValue} />
            <Tooltip labelFormatter={(v) => new Date(v).toLocaleString("tr-TR")} />
            {interfaces.map((iface, i) => (
              <Line key={iface} type="monotone" dataKey={iface} stroke={TIMELINE_COLORS[i % TIMELINE_COLORS.length]} dot={false} strokeWidth={1.5} name={iface} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <p className="text-xs text-text-secondary mb-1">{title || singleMetricName}</p>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={singleRows}>
          <XAxis dataKey="time" hide />
          <YAxis width={38} tick={{ fontSize: 10 }} tickFormatter={formatAxisValue} />
          <Tooltip labelFormatter={(v) => new Date(v).toLocaleString("tr-TR")} />
          <Line type="monotone" dataKey="value" stroke="var(--text-accent)" dot={false} strokeWidth={1.5} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// value_map'li (durum) metrikler için renkli blok zaman çizelgesi — çizgi grafik yerine,
// hangi durumun ne kadar sürdüğünü segment segment gösterir.
function StatusTimeline({ rows, valueMap, showLatest }: { rows: MetricPoint[]; valueMap: ValueMap; showLatest?: boolean }) {
  if (rows.length === 0) {
    return <p className="text-xs text-text-muted">Veri yok.</p>;
  }

  const labelFor = (value: number) => valueMap.mappings.find((m) => Number(m.value) === value)?.label ?? String(value);

  const sorted = [...rows].sort((a, b) => (a.time > b.time ? 1 : -1));
  const startMs = new Date(sorted[0].time).getTime();
  const endMs = new Date(sorted[sorted.length - 1].time).getTime();
  const totalMs = Math.max(endMs - startMs, 1);

  const segments: { label: string; widthPct: number }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const label = labelFor(sorted[i].value);
    const segStart = new Date(sorted[i].time).getTime();
    const segEnd = i < sorted.length - 1 ? new Date(sorted[i + 1].time).getTime() : endMs;
    const widthPct = Math.max(((segEnd - segStart) / totalMs) * 100, 0.5);
    if (segments.length > 0 && segments[segments.length - 1].label === label) {
      segments[segments.length - 1].widthPct += widthPct;
    } else {
      segments.push({ label, widthPct });
    }
  }

  const uniqueLabels = Array.from(new Set(segments.map((s) => s.label)));
  const colorFor = (label: string) => TIMELINE_COLORS[uniqueLabels.indexOf(label) % TIMELINE_COLORS.length];
  const latestLabel = labelFor(sorted[sorted.length - 1].value);

  return (
    <div>
      {showLatest && (
        <p className="text-sm font-medium mb-1.5" style={{ color: colorFor(latestLabel) }}>
          {latestLabel}
        </p>
      )}
      <div className="flex w-full h-4 rounded overflow-hidden">
        {segments.map((seg, i) => (
          <div key={i} style={{ width: `${seg.widthPct}%`, backgroundColor: colorFor(seg.label) }} title={seg.label} />
        ))}
      </div>
      <div className="flex flex-wrap gap-2 mt-1.5">
        {uniqueLabels.map((label) => (
          <span key={label} className="flex items-center gap-1 text-[10px] text-text-secondary">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colorFor(label) }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
