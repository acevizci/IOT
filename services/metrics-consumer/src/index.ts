import { createClient } from "redis";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  host: process.env.POSTGRES_HOST || "postgres",
  port: Number(process.env.POSTGRES_PORT) || 5432,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  max: 5
});

const redisUrl = process.env.REDIS_URL || "redis://redis:6379";
const STREAM_KEY = "metrics.raw";
const GROUP_NAME = "metrics-consumer-group";
const CONSUMER_NAME = `consumer-${process.pid}`;

interface MetricEvent {
  event_type: string;
  source_module: string;
  tenant_id: string;
  device_id: string;
  metric_name: string;
  timestamp: string;
  value: number;
  unit?: string;
  tags?: Record<string, string>;
}

async function ensureConsumerGroup(client: ReturnType<typeof createClient>) {
  try {
    await client.xGroupCreate(STREAM_KEY, GROUP_NAME, "0", { MKSTREAM: true });
    console.log(`[Consumer] Consumer group '${GROUP_NAME}' oluşturuldu.`);
  } catch (err: any) {
    if (err.message.includes("BUSYGROUP")) {
      console.log(`[Consumer] Consumer group '${GROUP_NAME}' zaten mevcut, devam ediliyor.`);
    } else {
      throw err;
    }
  }
}

async function writeMetricToDb(event: MetricEvent) {
  // FAZ J.0: SNMP-Table deseninin kullandığı tags.interface'in yanına, VMware/Hyper-V
  // (ve gelecekteki diğer çoklu-instance kaynaklar) için tags.instance_label da
  // çıkarılıyor -- her ikisi de metrics tablosunda AYRI, genel amaçlı kolonlar
  // (bkz. migration 075). Bir metrik olayı ikisini BİRDEN taşımaz (SNMP interface'leri
  // tags.interface, VMware/Hyper-V entity'leri tags.instance_label kullanır).
  await pool.query(
    `INSERT INTO metrics (time, tenant_id, device_id, metric_name, interface, instance_label, value, unit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      event.timestamp,
      event.tenant_id,
      event.device_id,
      event.metric_name,
      event.tags?.interface || null,
      event.tags?.instance_label || null,
      event.value,
      event.unit || null
    ]
  );
}

async function main() {
  const client = createClient({ url: redisUrl });
  client.on("error", (err) => console.error("[Consumer] Redis hatası:", err));
  await client.connect();

  await ensureConsumerGroup(client);
  console.log("[Consumer] Dinleme başlıyor...");

  while (true) {
    try {
      const response = await client.xReadGroup(
        GROUP_NAME,
        CONSUMER_NAME,
        [{ key: STREAM_KEY, id: ">" }],
        { COUNT: 10, BLOCK: 5000 }
      );

      if (!response) continue;

      for (const stream of response) {
        for (const message of stream.messages) {
          try {
            const event: MetricEvent = JSON.parse(message.message.data);
            await writeMetricToDb(event);
            await client.xAck(STREAM_KEY, GROUP_NAME, message.id);
            console.log(`[Consumer] Yazıldı: ${event.metric_name} = ${event.value} (device: ${event.device_id})`);
          } catch (err) {
            console.error(`[Consumer] Mesaj işlenirken hata (id: ${message.id}):`, err);
            // Not: hata durumunda ACK edilmiyor, mesaj tekrar denenebilir kalır.
          }
        }
      }
    } catch (err) {
      console.error("[Consumer] Döngü hatası:", err);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main().catch((err) => {
  console.error("[Consumer] Başlatma hatası:", err);
  process.exit(1);
});
