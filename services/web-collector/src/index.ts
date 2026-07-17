import http from "http";
import { connectRedis } from "./redisClient.js";
import { fetchAllScenarios, fetchScenarioSteps, reconcileSchedule, fetchDueSchedule, markScheduleCollectedBatch } from "./coreClient.js";
import type { MarkCollectedEntry } from "./coreClient.js";
import { runScenario } from "./scenarioRunner.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 60000;
const HTTP_PORT = Number(process.env.HTTP_PORT) || 3400;

let lastTickAt = Date.now();

function startHealthServer() {
  http.createServer((req, res) => {
    if (req.url === "/health") {
      const staleMs = Date.now() - lastTickAt;
      const healthy = staleMs < POLL_INTERVAL_MS * 3;
      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: healthy ? "ok" : "stale", service: "web-collector", last_tick_ms_ago: staleMs }));
    } else {
      res.writeHead(404);
      res.end();
    }
  }).listen(HTTP_PORT, () => console.log(`[Web-Collector] Health check HTTP: ${HTTP_PORT}`));
}

async function pollAllScenarios() {
  lastTickAt = Date.now();
  // Faz Queue-2 (son collector): artik TUM senaryolari her tick'te calistirmak
  // yerine, Core Service'in "vadesi gelmis" dedigi senaryolari calistiriyoruz.
  await reconcileSchedule();
  const due = await fetchDueSchedule();
  const dueScenarioIds = new Set(due.map((d) => d.resource_id));

  const scenarios = await fetchAllScenarios();
  const dueScenarios = scenarios.filter((s) => dueScenarioIds.has(s.id));
  if (dueScenarios.length === 0) return;
  console.log(`[Web-Collector] ${dueScenarios.length} senaryo kontrol ediliyor...`);
  const collectedEntries: MarkCollectedEntry[] = [];
  for (const scenario of dueScenarios) {
    const steps = await fetchScenarioSteps(scenario.id);
    if (steps.length === 0) continue;
    const startedAt = Date.now();
    const errorMsg = await runScenario(scenario, steps);
    // device_id null olan senaryolar reconcile tarafindan hic eklenmedigi icin
    // dueScenarioIds'e hic giremezler, bu yuzden burada device_id'nin dolu
    // oldugundan eminiz -- yine de savunmaci bir kontrol.
    if (scenario.device_id) {
      collectedEntries.push({ device_id: scenario.device_id, resource_type: "web_scenario", resource_id: scenario.id, duration_ms: Date.now() - startedAt, error: errorMsg });
    }
  }
  // Performans DÜZELTMESİ: N ayrı istek yerine TEK bir batch istek.
  await markScheduleCollectedBatch(collectedEntries);
}

// GÜVENİLİRLİK DÜZELTMESİ: bkz. npm-service/alarm-engine'deki aynı sınıf hata.
function safeRun(fn: () => Promise<void>, label: string): () => void {
  return () => {
    fn().catch((err) => {
      console.error(`[Web-Collector] ${label} sırasında yakalanmamış hata (bir sonraki tur devam edecek):`, err);
    });
  };
}

async function main() {
  await connectRedis();
  console.log("[Web-Collector] Redis bağlantısı kuruldu, polling döngüsü başlıyor...");
  startHealthServer();
  const safePollAllScenarios = safeRun(pollAllScenarios, "pollAllScenarios");
  safePollAllScenarios();
  setInterval(safePollAllScenarios, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[Web-Collector] Başlatma hatası:", err);
  process.exit(1);
});
