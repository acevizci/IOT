import { createClient } from "redis";

const redisUrl = process.env.REDIS_URL || "redis://redis:6379";
export const redisClient = createClient({ url: redisUrl });

redisClient.on("error", (err) => console.error("[SQL-Collector] Redis hatası:", err));

export async function connectRedis() {
  await redisClient.connect();
}

export interface MetricEvent {
  event_type: "metric";
  source_module: "sql-collector";
  tenant_id: string;
  device_id: string;
  metric_name: string;
  timestamp: string;
  value: number;
  unit?: string;
}

export async function publishMetric(event: MetricEvent) {
  await redisClient.xAdd(
    "metrics.raw",
    "*",
    { data: JSON.stringify(event) },
    { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 100000 } }
  );
}
