import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { useMetrics } from "../../devices/useMetrics";

export function GraphWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const deviceId = config.device_id;
  const metricName = config.metric_name;
  const hours = config.hours || 6;

  const { data: metricsResult, isLoading } = useMetrics(deviceId, metricName, hours);
  const data = metricsResult?.rows;

  if (!deviceId || !metricName) {
    return <p className="text-xs text-text-muted p-2">Widget ayarlarında cihaz/metrik seçilmemiş.</p>;
  }

  return (
    <div className="h-full flex flex-col">
      <p className="text-xs text-text-secondary mb-1">{title || metricName}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <XAxis dataKey="time" hide />
            <YAxis width={30} tick={{ fontSize: 10 }} />
            <Tooltip labelFormatter={(v) => new Date(v).toLocaleString("tr-TR")} />
            <Line type="monotone" dataKey="value" stroke="var(--text-accent)" dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
