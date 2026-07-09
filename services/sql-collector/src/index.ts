import { connectRedis } from "./redisClient.js";
import { fetchAllDeviceIds, fetchEffectiveItems } from "./coreClient.js";
import { pollSqlItem } from "./sqlPoller.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 60000;

async function pollAllSqlItems() {
  const devices = await fetchAllDeviceIds();
  let sqlItemCount = 0;

  for (const device of devices) {
    const items = await fetchEffectiveItems(device.id);
    const sqlItems = items.filter((i) => i.collector_type === "sql_postgres" || i.collector_type === "sql_mysql");

    for (const item of sqlItems) {
      await pollSqlItem(device, item, new Date().toISOString());
      sqlItemCount++;
    }
  }

  if (sqlItemCount > 0) {
    console.log(`[SQL-Collector] ${sqlItemCount} SQL item polling edildi`);
  }
}

async function main() {
  await connectRedis();
  console.log("[SQL-Collector] Redis bağlantısı kuruldu, polling döngüsü başlıyor...");
  await pollAllSqlItems();
  setInterval(pollAllSqlItems, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[SQL-Collector] Başlatma hatası:", err);
  process.exit(1);
});
