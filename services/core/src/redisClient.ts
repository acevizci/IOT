import { createClient } from "redis";

const redisUrl = process.env.REDIS_URL || "redis://redis:6379";
export const redisClient = createClient({ url: redisUrl });
redisClient.on("error", (err) => console.error("Redis Client Error (core-service)", err));

let connected = false;
export async function ensureRedisConnected() {
  if (!connected) {
    await redisClient.connect();
    connected = true;
  }
}

export interface MetricEvent {
  event_type: "metric";
  source_module: "agent";
  tenant_id: string;
  device_id: string;
  metric_name: string;
  timestamp: string;
  value: number;
  unit?: string;
  interface?: string;
  // FAZ J Adım 7a: Hyper-V (ve gelecekteki diğer çoklu-instance kaynaklar) için --
  // önceden bu tip (core-service'in agent-özel MetricEvent'i) sadece `interface`
  // taşıyordu, npm-service/sql-collector/vb.'nin KENDİ redisClient.ts'lerindeki
  // MetricEvent tipinde zaten var olan genel `tags` alanı burada YOKTU -- agent
  // kaynaklı metrikler bu yüzden hiçbir zaman instance_label (veya başka bir tag)
  // taşıyamıyordu, zincir en baştan (bu handler'da) kırıktı.
  tags?: Record<string, string>;
}

// Diğer collector servisleriyle AYNI stream ismini ve veri formatını (tek JSON string
// içinde "data" alanı) kullanır — metrics-consumer'ın bu event'i diğerlerinden ayırt
// edememesi (tutarlı işlenmesi) için kritik.
export async function publishAgentMetric(event: MetricEvent) {
  await ensureRedisConnected();
  await redisClient.xAdd(
    "metrics.raw",
    "*",
    { data: JSON.stringify(event) },
    { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 100000 } }
  );
}
