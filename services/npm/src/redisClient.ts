import { createClient } from "redis";

const redisUrl = process.env.REDIS_URL || "redis://redis:6379";
export const redisClient = createClient({ url: redisUrl });

redisClient.on("error", (err) => console.error("Redis Client Error", err));

export async function connectRedis() {
  await redisClient.connect();
}

export interface MetricEvent {
  event_type: "metric";
  source_module: "npm";
  tenant_id: string;
  device_id: string;
  metric_name: string;
  timestamp: string;
  value: number;
  unit?: string;
  tags?: Record<string, string>;
}

// Bu fonksiyon ileride "merkeze HTTPS ile gönder" şeklinde değiştirilecek yer.
// Şimdilik doğrudan yerel Redis Stream'e yazıyor.
export async function publishMetric(event: MetricEvent) {
  await redisClient.xAdd(
    "metrics.raw",
    "*",
    { data: JSON.stringify(event) },
    { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 100000 } }
  );
}
