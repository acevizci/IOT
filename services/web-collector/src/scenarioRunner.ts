import { publishMetric } from "./redisClient.js";
import type { ScenarioRow, ScenarioStep } from "./coreClient.js";

export async function runScenario(scenario: ScenarioRow, steps: ScenarioStep[]): Promise<void> {
  const timestamp = new Date().toISOString();
  // Web scenario'lar belirli bir "cihaza" bağlı olmayabilir (dış URL izleme) — bağlıysa
  // onu, değilse senaryonun kendi ID'sini pseudo-device_id olarak kullanıyoruz.
  const deviceId = scenario.device_id || scenario.id;

  for (const step of steps) {
    const startTime = Date.now();
    let statusCode = 0;
    let success = false;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(step.url, {
        method: "GET",
        headers: scenario.user_agent ? { "User-Agent": scenario.user_agent } : {},
        signal: controller.signal
      });
      clearTimeout(timeout);
      statusCode = response.status;
      success = response.status === step.expected_status_code;
    } catch (err: any) {
      console.log(`[Web-Scenario] ${scenario.name} / ${step.name}: istek hatası - ${err.message}`);
    }

    const responseTimeMs = Date.now() - startTime;
    const metricPrefix = `web_${scenario.name.replace(/\s+/g, "_")}_${step.name.replace(/\s+/g, "_")}`;

    await publishMetric({
      event_type: "metric", source_module: "web-collector", tenant_id: scenario.tenant_id, device_id: deviceId,
      metric_name: `${metricPrefix}_response_code`, timestamp, value: statusCode, unit: "code"
    });
    await publishMetric({
      event_type: "metric", source_module: "web-collector", tenant_id: scenario.tenant_id, device_id: deviceId,
      metric_name: `${metricPrefix}_response_time_ms`, timestamp, value: responseTimeMs, unit: "ms"
    });
    await publishMetric({
      event_type: "metric", source_module: "web-collector", tenant_id: scenario.tenant_id, device_id: deviceId,
      metric_name: `${metricPrefix}_status`, timestamp, value: success ? 1 : 0, unit: "status"
    });

    console.log(`[Web-Scenario] ${scenario.name} / ${step.name}: ${statusCode} (beklenen ${step.expected_status_code}) - ${responseTimeMs}ms - ${success ? "OK" : "BAŞARISIZ"}`);
  }
}
