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
  // tags.instance_label -> metrics-consumer bunu metrics.instance_label'a yazar
  // (per-instance gruplama/alarm; örn. Kafka consumer lag'de grup adı).
  tags?: Record<string, string>;
}

export async function publishMetric(event: MetricEvent) {
  try {
    await redisClient.xAdd(
      "metrics.raw",
      "*",
      { data: JSON.stringify(event) },
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 100000 } }
    );
  } catch (err) {
    // DAYANIKLILIK: Redis gecici olarak yazamiyorsa (disk dolu -> RDB snapshot hatasi
    // -> MISCONF, stop-writes-on-bgsave-error), xAdd reddederdi. Bu reddin await
    // zincirinin DISINA (ornek: new Promise icindeki async SNMP callback'i) kacmasi
    // TUM process'i cokertiyordu. Metrik yayini best-effort'tur: kaybi loglayip devam
    // ediyoruz -- collector ayakta kalir, Redis duzelince kaldigi yerden surer.
    console.error("[publishMetric] Redis yazilamadi, metrik atlandi:", (err as Error).message);
  }
}
