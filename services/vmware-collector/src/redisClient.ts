import { createClient } from "redis";

const redisUrl = process.env.REDIS_URL || "redis://redis:6379";
const redisClient = createClient({ url: redisUrl });
redisClient.on("error", (err) => console.error("[Redis] Bağlantı hatası:", err));

let connected = false;
export async function connectRedis() {
  if (!connected) {
    await redisClient.connect();
    connected = true;
  }
}

export interface MetricEvent {
  event_type: "metric";
  source_module: "vmware";
  tenant_id: string;
  device_id: string;
  metric_name: string;
  timestamp: string;
  value: number;
  unit?: string;
  tags?: Record<string, string>;
}

export async function publishMetric(event: MetricEvent) {
  await redisClient.xAdd(
    "metrics.raw",
    "*",
    { data: JSON.stringify(event) },
    { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 100000 } }
  );
}
