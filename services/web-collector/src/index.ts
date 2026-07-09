import { connectRedis } from "./redisClient.js";
import { fetchAllScenarios, fetchScenarioSteps } from "./coreClient.js";
import { runScenario } from "./scenarioRunner.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 60000;

async function pollAllScenarios() {
  const scenarios = await fetchAllScenarios();
  if (scenarios.length === 0) return;

  console.log(`[Web-Collector] ${scenarios.length} senaryo kontrol ediliyor...`);

  for (const scenario of scenarios) {
    const steps = await fetchScenarioSteps(scenario.id);
    if (steps.length === 0) continue;
    await runScenario(scenario, steps);
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
