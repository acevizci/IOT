import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { useMetrics, useMetricNames } from "../../devices/useMetrics";
import { useValueMaps } from "../../valueMaps/useValueMaps";
import type { ValueMap } from "../../../api/valueMaps";
import type { MetricPoint } from "../../../api/metrics";

// Durum zaman çizelgesi ve çoklu-satır grafiklerde döngüsel olarak kullanılan sabit palet.
const TIMELINE_COLORS = ["#378ADD", "#D85A30", "#4CAF50", "#F2A93B", "#9C6ADE", "#E85D9C", "#4FB3BF", "#C77D3A"];

// Y ekseni etiketleri için: büyük sayılar (örneğin 32-bit sayaç max değeri
// 4294967295) varsayılan genişlikte kırpılıp anlamsız görüntü veriyordu.
function formatAxisValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}G`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

export function GraphWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const deviceId = config.device_id;
  const metricName = config.metric_name;
  const hours = config.hours || 6;

  const { data: metricEntries } = useMetricNames(deviceId);
  const { data: valueMaps } = useValueMaps();

  // Bu metriğin nasıl gösterileceğini belirleyen meta veri (Faz 9.1). Aynı metric_name
  // birden fazla satırda (her interface için bir tane) tekrarlanabilir — hepsi aynı
  // meta'yı taşıdığı için ilk eşleşen yeterli.
  const meta = metricEntries?.find((m) => m.metric_name === metricName);
  const dataType = meta?.data_type ?? "gauge";
  const isTable = meta?.is_table ?? false;
  const valueMapId = meta?.value_map_id ?? null;
  const valueMap = valueMapId ? valueMaps?.find((vm) => vm.id === valueMapId) : undefined;

  // is_table ise interface filtresi VERMİYORUZ — tüm satırların verisi tek seferde gelir,
  // aşağıda interface'e göre grupluyoruz.
  const { data: metricsResult, isLoading } = useMetrics(deviceId, metricName, hours);
  const rows = metricsResult?.rows ?? [];

  if (!deviceId || !metricName) {
    return <p className="text-xs text-text-muted p-2">Widget ayarlarında cihaz/metrik seçilmemiş.</p>;
  }

  if (dataType === "string") {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center gap-1">
        <p className="text-xs text-text-secondary">{title || metricName}</p>
        <p className="text-xs text-text-muted">Bu metrik metin tipinde — grafikte gösterilemez.</p>
      </div>
    );
  }

  if (isLoading) {
    return <p className="text-xs text-text-muted p-2">Yükleniyor...</p>;
  }

  // Hem tablo (çoklu satır) hem durum haritalı bir metrik — her satır için ayrı,
  // kompakt bir durum zaman çizelgesi alt alta gösterilir (örn. her interface'in
  // if_oper_status'u kendi şeridinde).
  if (valueMap && isTable) {
    const interfaces = Array.from(new Set(rows.map((r) => r.interface).filter(Boolean))) as string[];
    return (
      <div className="h-full flex flex-col gap-2 overflow-y-auto">
        <p className="text-xs text-text-secondary">{title || metricName}</p>
        {interfaces.length === 0 && <p className="text-xs text-text-muted">Veri yok.</p>}
        {interfaces.map((iface) => (
          <div key={iface}>
            <p className="text-[10px] text-text-muted mb-0.5">{iface}</p>
            <StatusTimeline rows={rows.filter((r) => r.interface === iface)} valueMap={valueMap} />
          </div>
        ))}
      </div>
    );
  }

  // Durum haritalı, tekil metrik — renkli blok zaman çizelgesi (Zabbix tarzı).
  if (valueMap) {
    return (
      <div className="h-full flex flex-col justify-center">
        <p className="text-xs text-text-secondary mb-2">{title || metricName}</p>
        <StatusTimeline rows={rows} valueMap={valueMap} showLatest />
      </div>
    );
  }

  // Tablo (çoklu satır), durum haritası olmayan — her interface kendi renginde çizgi.
  if (isTable) {
    const interfaces = Array.from(new Set(rows.map((r) => r.interface).filter(Boolean))) as string[];
    const byTime = new Map<string, Record<string, any>>();
    for (const row of rows) {
      if (!byTime.has(row.time)) byTime.set(row.time, { time: row.time });
      byTime.get(row.time)![row.interface || "değer"] = row.value;
    }
    const chartData = Array.from(byTime.values()).sort((a, b) => (a.time > b.time ? 1 : -1));

    return (
      <div className="h-full flex flex-col">
        <p className="text-xs text-text-secondary mb-1">{title || metricName}</p>
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

  // Varsayılan: tekil çizgi grafik (mevcut/önceki davranış, değişmedi).
  return (
    <div className="h-full flex flex-col">
      <p className="text-xs text-text-secondary mb-1">{title || metricName}</p>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows}>
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
// hangi durumun ne kadar sürdüğünü segment segment gösterir. Ardışık aynı değerler tek
// segmentte birleştirilir, segment genişliği süreye orantılıdır.
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
