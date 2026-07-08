import { createClient } from "redis";

const redisUrl = process.env.REDIS_URL || "redis://redis:6379";
export const redisClient = createClient({ url: redisUrl });

redisClient.on("error", (err) => console.error("Redis Client Error", err));

export async function connectRedis() {
  await redisClient.connect();
}

export interface FlowEvent {
  event_type: "flow";
  source_module: "nta";
  tenant_id: string;
  device_id: string;
  timestamp: string;
  src_ip: string;
  dst_ip: string;
  src_port: number;
  dst_port: number;
  protocol: number;
  bytes: number;
  packets: number;
  sampling_rate: number;
}

export async function publishFlow(event: FlowEvent) {
  await redisClient.xAdd(
    "flows.raw",
    "*",
    { data: JSON.stringify(event) },
    { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 500000 } }
  );
}
