import http from "http";
import { connectRedis } from "./redisClient.js";
import { fetchAllDeviceIds, fetchEffectiveItems, reconcileSchedule, fetchDueSchedule, markScheduleCollectedBatch } from "./coreClient.js";
import type { MarkCollectedEntry } from "./coreClient.js";
import { pollSqlItem } from "./sqlPoller.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 60000;
const HTTP_PORT = Number(process.env.HTTP_PORT) || 3300;

// SQL collector iki ayri collector_type isliyor (postgres/mysql) -- her ikisi
// icin de ayri reconcile+due cekilir (npm-service'teki NPM_COLLECTOR_TYPES
// dongusuyle ayni desen).
const SQL_COLLECTOR_TYPES = ["sql_postgres", "sql_mysql", "mongodb", "kafka", "rabbitmq"];

// GÜVENİLİRLİK: sadece "process ayakta mı" değil, "polling döngüsü GERÇEKTEN
// çalışıyor mu" diye kontrol eden bir health check. lastTickAt, her turun
// BAŞINDA güncellenir -- eğer beklenenden çok daha uzun süredir güncellenmiyorsa
// (döngü bir yerde takılı kalmış olabilir), /health 503 döner.
let lastTickAt = Date.now();

function startHealthServer() {
  http.createServer((req, res) => {
    if (req.url === "/health") {
      const staleMs = Date.now() - lastTickAt;
      const healthy = staleMs < POLL_INTERVAL_MS * 3;
      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: healthy ? "ok" : "stale", service: "sql-collector", last_tick_ms_ago: staleMs }));
    } else {
      res.writeHead(404);
      res.end();
    }
  }).listen(HTTP_PORT, () => console.log(`[SQL-Collector] Health check HTTP: ${HTTP_PORT}`));
}

async function pollAllSqlItems() {
  lastTickAt = Date.now();
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
      (i) => (i.collector_type === "sql_postgres" || i.collector_type === "sql_mysql" || i.collector_type === "mongodb" || i.collector_type === "kafka" || i.collector_type === "rabbitmq") && dueResourceIds.has(i.id)
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

// GÜVENİLİRLİK DÜZELTMESİ: bkz. npm-service/alarm-engine'deki aynı sınıf hata --
// setInterval ile çağrılan fonksiyon hata fırlatırsa önceden tüm process çöküyordu.
function safeRun(fn: () => Promise<void>, label: string): () => void {
  return () => {
    fn().catch((err) => {
      console.error(`[SQL-Collector] ${label} sırasında yakalanmamış hata (bir sonraki tur devam edecek):`, err);
    });
  };
}

async function main() {
  await connectRedis();
  console.log("[SQL-Collector] Redis bağlantısı kuruldu, polling döngüsü başlıyor...");
  startHealthServer();
  const safePollAllSqlItems = safeRun(pollAllSqlItems, "pollAllSqlItems");
  safePollAllSqlItems();
  setInterval(safePollAllSqlItems, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[SQL-Collector] Başlatma hatası:", err);
  process.exit(1);
});
