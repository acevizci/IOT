import { useQuery } from "@tanstack/react-query";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { fetchSeverityDistribution } from "../../../api/dashboards";
import { SEVERITY_COLORS } from "../../../theme";

export function PieChartWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const source = config.source || "severity_distribution";
  const { data, isLoading } = useQuery({
    queryKey: ["widget-pie-chart", source, config.device_group_id],
    queryFn: () => fetchSeverityDistribution(config.device_group_id),
    enabled: source === "severity_distribution",
    refetchInterval: 30000
  });

  return (
    <div className="h-full flex flex-col">
      <p className="text-xs text-text-secondary mb-1">{title || "Severity Dağılımı"}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : data && data.length > 0 ? (
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="count" nameKey="severity" cx="50%" cy="50%" outerRadius="70%">
              {data.map((d) => <Cell key={d.severity} fill={SEVERITY_COLORS[d.severity] || "#888"} />)}
            </Pie>
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 10 }} />
          </PieChart>
        </ResponsiveContainer>
      ) : (
        <p className="text-xs text-text-muted flex-1 flex items-center justify-center">Veri yok.</p>
      )}
    </div>
  );
}
