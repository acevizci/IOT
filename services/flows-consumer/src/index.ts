import { createClient } from "redis";
import { insertFlows, FlowRow } from "./clickhouse.js";

const redisUrl = process.env.REDIS_URL || "redis://redis:6379";
const STREAM_KEY = "flows.raw";
const GROUP_NAME = "flows-consumer-group";
const CONSUMER_NAME = `consumer-${process.pid}`;

const BATCH_SIZE = 500;
const BATCH_INTERVAL_MS = 2000;

interface FlowEvent {
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
}

async function ensureConsumerGroup(client: ReturnType<typeof createClient>) {
  try {
    await client.xGroupCreate(STREAM_KEY, GROUP_NAME, "0", { MKSTREAM: true });
    console.log(`[FlowsConsumer] Consumer group '${GROUP_NAME}' oluşturuldu.`);
  } catch (err: any) {
    if (err.message.includes("BUSYGROUP")) {
      console.log(`[FlowsConsumer] Consumer group '${GROUP_NAME}' zaten mevcut.`);
    } else {
      throw err;
    }
  }
}

async function main() {
  const client = createClient({ url: redisUrl });
  client.on("error", (err) => console.error("[FlowsConsumer] Redis hatası:", err));
  await client.connect();

  await ensureConsumerGroup(client);
  console.log("[FlowsConsumer] Dinleme başlıyor...");

  let buffer: FlowRow[] = [];
  let pendingIds: string[] = [];
  let lastFlush = Date.now();

  async function flush() {
    if (buffer.length === 0) return;
    const toInsert = buffer;
    const toAck = pendingIds;
    buffer = [];
    pendingIds = [];
    lastFlush = Date.now();

    try {
      await insertFlows(toInsert);
      await client.xAck(STREAM_KEY, GROUP_NAME, toAck);
      console.log(`[FlowsConsumer] ${toInsert.length} flow ClickHouse'a yazıldı.`);
    } catch (err) {
      console.error("[FlowsConsumer] Batch yazma hatası:", err);
      // Not: hata durumunda ACK edilmedi, mesajlar tekrar denenebilir kalır.
    }
  }

  while (true) {
    try {
      const response = await client.xReadGroup(
        GROUP_NAME,
        CONSUMER_NAME,
        [{ key: STREAM_KEY, id: ">" }],
        { COUNT: 100, BLOCK: 1000 }
      );

      if (response) {
        for (const stream of response) {
          for (const message of stream.messages) {
            try {
              const event: FlowEvent = JSON.parse(message.message.data);
              buffer.push({
                timestamp: event.timestamp,
                tenant_id: event.tenant_id,
                device_id: event.device_id,
                src_ip: event.src_ip,
                dst_ip: event.dst_ip,
                src_port: event.src_port,
                dst_port: event.dst_port,
                protocol: event.protocol,
                bytes: event.bytes,
                packets: event.packets
              });
              pendingIds.push(message.id);
            } catch (err) {
              console.error(`[FlowsConsumer] Mesaj parse hatası (id: ${message.id}):`, err);
            }
          }
        }
      }

      if (buffer.length >= BATCH_SIZE || Date.now() - lastFlush >= BATCH_INTERVAL_MS) {
        await flush();
      }
    } catch (err) {
      console.error("[FlowsConsumer] Döngü hatası:", err);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main().catch((err) => {
  console.error("[FlowsConsumer] Başlatma hatası:", err);
  process.exit(1);
});
