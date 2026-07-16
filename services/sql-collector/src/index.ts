import { connectRedis } from "./redisClient.js";
import { fetchAllDeviceIds, fetchEffectiveItems, reconcileSchedule, fetchDueSchedule, markScheduleCollected } from "./coreClient.js";
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
  for (const device of devices) {
    const items = await fetchEffectiveItems(device.id);
    const sqlItems = items.filter(
      (i) => (i.collector_type === "sql_postgres" || i.collector_type === "sql_mysql") && dueResourceIds.has(i.id)
    );
    for (const item of sqlItems) {
      const startedAt = Date.now();
      await pollSqlItem(device, item, new Date().toISOString());
      await markScheduleCollected(device.id, "template_item", item.id, Date.now() - startedAt);
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
