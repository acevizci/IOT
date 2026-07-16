import { connectRedis } from "./redisClient.js";
import { fetchAllScenarios, fetchScenarioSteps, reconcileSchedule, fetchDueSchedule, markScheduleCollected } from "./coreClient.js";
import { runScenario } from "./scenarioRunner.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 60000;

async function pollAllScenarios() {
  // Faz Queue-2 (son collector): artik TUM senaryolari her tick'te calistirmak
  // yerine, Core Service'in "vadesi gelmis" dedigi senaryolari calistiriyoruz.
  await reconcileSchedule();
  const due = await fetchDueSchedule();
  const dueScenarioIds = new Set(due.map((d) => d.resource_id));

  const scenarios = await fetchAllScenarios();
  const dueScenarios = scenarios.filter((s) => dueScenarioIds.has(s.id));
  if (dueScenarios.length === 0) return;
  console.log(`[Web-Collector] ${dueScenarios.length} senaryo kontrol ediliyor...`);
  for (const scenario of dueScenarios) {
    const steps = await fetchScenarioSteps(scenario.id);
    if (steps.length === 0) continue;
    const startedAt = Date.now();
    const errorMsg = await runScenario(scenario, steps);
    // device_id null olan senaryolar reconcile tarafindan hic eklenmedigi icin
    // dueScenarioIds'e hic giremezler, bu yuzden burada device_id'nin dolu
    // oldugundan eminiz -- yine de savunmaci bir kontrol.
    if (scenario.device_id) {
      await markScheduleCollected(scenario.device_id, scenario.id, Date.now() - startedAt, errorMsg);
    }
  }
}

async function main() {
  await connectRedis();
  console.log("[Web-Collector] Redis bağlantısı kuruldu, polling döngüsü başlıyor...");
  await pollAllScenarios();
  setInterval(pollAllScenarios, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[Web-Collector] Başlatma hatası:", err);
  process.exit(1);
});
