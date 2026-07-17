import { connectRedis } from "./redisClient.js";
import { fetchAllDeviceIds, fetchEffectiveItems, reconcileSchedule, fetchDueSchedule, markScheduleCollectedBatch } from "./coreClient.js";
import type { MarkCollectedEntry } from "./coreClient.js";
import { pollSqlItem } from "./sqlPoller.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 60000;

// SQL collector iki ayri collector_type isliyor (postgres/mysql) -- her ikisi
// icin de ayri reconcile+due cekilir (npm-service'teki NPM_COLLECTOR_TYPES
// dongusuyle ayni desen).
const SQL_COLLECTOR_TYPES = ["sql_postgres", "sql_mysql"];

async function pollAllSqlItems() {
  const dueResourceIds = new Set<string>();
  for (const collectorType of SQL_COLLECTOR_TYPES) {
    await reconcileSchedule(collectorType);
    const due = await fetchDueSchedule(collectorType);
    for (const entry of due) dueResourceIds.add(entry.resource_id);
  }

  const devices = await fetchAllDeviceIds();
  let sqlItemCount = 0;
  const collectedEntries: MarkCollectedEntry[] = [];
  for (const device of devices) {
    const items = await fetchEffectiveItems(device.id);
    const sqlItems = items.filter(
      (i) => (i.collector_type === "sql_postgres" || i.collector_type === "sql_mysql") && dueResourceIds.has(i.id)
    );
    for (const item of sqlItems) {
      const startedAt = Date.now();
      const errorMsg = await pollSqlItem(device, item, new Date().toISOString());
      collectedEntries.push({ device_id: device.id, resource_type: "template_item", resource_id: item.id, duration_ms: Date.now() - startedAt, error: errorMsg });
      sqlItemCount++;
    }
  }
  // Performans DÜZELTMESİ: N ayrı istek yerine TEK bir batch istek.
  await markScheduleCollectedBatch(collectedEntries);
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
