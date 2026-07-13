import { publishMetric } from "./redisClient.js";
import { reportCollectorStatus, fetchDeviceWebInterface } from "./coreClient.js";

// Senaryo gerçek bir cihaza bağlıysa VE step.url göreli bir path'se (örn. "/api/health"),
// cihazın kendi "web" interface'inden (IP+port) tam URL'i çözer. Mutlak URL'ler
// (http://... ile başlayanlar — dış hedef izleme, çoğu senaryomuzun kullandığı yöntem)
// hiç etkilenmez, olduğu gibi kullanılır.
async function resolveStepUrl(scenario: ScenarioRow, rawUrl: string): Promise<string> {
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) return rawUrl;
  if (!scenario.device_id) return rawUrl;

  const iface = await fetchDeviceWebInterface(scenario.device_id);
  if (!iface) return rawUrl;

  const port = iface.port ? `:${iface.port}` : "";
  const path = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
  return `http://${iface.ip_address}${port}${path}`;
}
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
      const resolvedUrl = await resolveStepUrl(scenario, step.url);
      const response = await fetch(resolvedUrl, {
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
    // Sadece gerçek bir cihaza bağlı senaryolarda raporla — pseudo-device_id (senaryonun
    // kendi id'si) devices tablosunda yok, FK ihlaline yol açar.
    if (scenario.device_id) {
      await reportCollectorStatus(scenario.device_id, success ? "active" : "down", success ? undefined : `HTTP ${statusCode}, beklenen ${step.expected_status_code}`);
    }
  }
}
