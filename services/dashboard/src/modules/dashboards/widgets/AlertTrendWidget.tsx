import { useQuery } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { fetchAlertTrend } from "../../../api/dashboards";
import { useDeviceGroup } from "../../deviceGroups/useDeviceGroups";
import { SEVERITY_COLORS, SEVERITY_LABELS } from "../../../theme";
import { resolveRefreshInterval } from "./refreshInterval";

const SEVERITY_ORDER = ["info", "warning", "average", "high", "disaster", "critical"];

// Kullanıcı önerisi: severity_distribution widget'ı SADECE anlık durumu
// gösteriyor ("şu an kaç tane açık disaster var") -- bu widget ZAMAN İÇİNDE
// yeni tetiklenen alarm sayısını (severity'ye göre yığılmış bar grafiği)
// gösterir. Zabbix'in "Problems by severity" zaman-serisi grafiği / Grafana-
// Datadog'un "alerts fired over time" panelleriyle AYNI fikir.
export function AlertTrendWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const { data: group } = useDeviceGroup(config.device_group_id || "");
  const scopeLabel = config.device_group_id ? (group?.name || "…") : "Tüm cihazlar";
  const hours = config.hours || 24;
  const isHourly = hours <= 48;

  const { data, isLoading } = useQuery({
    queryKey: ["widget-alert-trend", config.device_group_id, hours],
    queryFn: () => fetchAlertTrend(config.device_group_id, hours),
    refetchInterval: resolveRefreshInterval(config, 60000)
  });

  const buckets = new Map<string, Record<string, any>>();
  for (const row of data ?? []) {
    if (!buckets.has(row.bucket)) buckets.set(row.bucket, { bucket: row.bucket });
    buckets.get(row.bucket)![row.severity] = row.count;
  }
  const chartData = Array.from(buckets.values()).sort((a, b) => (a.bucket > b.bucket ? 1 : -1));

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary">{title || "Alarm Trend"}</p>
      <p className="text-[10px] text-text-muted mb-2 truncate">
        {scopeLabel} · son {hours < 168 ? `${hours} saat` : `${Math.round(hours / 24)} gün`}
      </p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : chartData.length === 0 ? (
        <p className="text-xs text-text-muted">Bu aralıkta tetiklenen alarm yok.</p>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData}>
            <XAxis
              dataKey="bucket"
              tick={{ fontSize: 9 }}
              tickFormatter={(v) =>
                isHourly
                  ? new Date(v).toLocaleTimeString("tr-TR", { hour: "2-digit" })
                  : new Date(v).toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit" })
              }
            />
            <YAxis width={28} tick={{ fontSize: 10 }} allowDecimals={false} />
            <Tooltip labelFormatter={(v) => new Date(v).toLocaleString("tr-TR")} />
            <Legend wrapperStyle={{ fontSize: 10 }} formatter={(value) => SEVERITY_LABELS[value] ?? value} />
            {SEVERITY_ORDER.map((sev) => (
              <Bar key={sev} dataKey={sev} stackId="severity" fill={SEVERITY_COLORS[sev]} name={sev} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
