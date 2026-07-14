import { publishMetric } from "./redisClient.js";
import { reportCollectorStatus, fetchDeviceWebInterface, resolveUrlMacros } from "./coreClient.js";

// URL'yi iki aşamada çözer:
//   1) {$MAKRO} referansları varsa (44 template import'undan kalma {$WEB.URL} gibi),
//      SSH/SQL'in kullandığı aynı mekanizmayla (resolve-config) çözülür.
//   2) Hâlâ göreli bir path'se (örn. "/api/health"), senaryonun bağlı olduğu cihazın
//      kendi "web" interface'inden (IP+port) tam URL türetilir.
// Mutlak URL'ler (http://... — dış hedef izleme, çoğu senaryomuzun kullandığı yöntem)
// hiç etkilenmez. device_id hiç yoksa (template hiçbir cihaza atanmamış) ve URL hâlâ
// çözülemezse, null döner — istek hiç atılmaz, "URL parse hatası" yerine net bir log yazılır.
async function resolveStepUrl(scenario: ScenarioRow, rawUrl: string): Promise<string | null> {
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) return rawUrl;

  let url = rawUrl;
  if (scenario.device_id && /\{\$[A-Z0-9_.]+\}/.test(url)) {
    const macroResolved = await resolveUrlMacros(scenario.device_id, url);
    if (macroResolved) url = macroResolved;
  }

  if (url.startsWith("http://") || url.startsWith("https://")) return url;

  if (scenario.device_id) {
    const iface = await fetchDeviceWebInterface(scenario.device_id);
    if (iface) {
      const port = iface.port ? `:${iface.port}` : "";
      const path = url.startsWith("/") ? url : `/${url}`;
      return `http://${iface.ip_address}${port}${path}`;
    }
  }

  return null; // çözülemedi — istek atılmayacak
}
import type { ScenarioRow, ScenarioStep } from "./coreClient.js";

export async function runScenario(scenario: ScenarioRow, steps: ScenarioStep[]): Promise<void> {
  const timestamp = new Date().toISOString();
  // Web scenario'lar belirli bir "cihaza" bağlı olmayabilir (dış URL izleme) — bağlıysa
  // onu, değilse senaryonun kendi ID'sini pseudo-device_id olarak kullanıyoruz.
  const deviceId = scenario.device_id || scenario.id;
  let anyStepFailed = false; // web.test.fail[senaryo] Zabbix trigger'ı için -- senaryo
                              // seviyesinde "herhangi bir adım başarısız oldu mu" özeti

  for (const step of steps) {
    const startTime = Date.now();
    let statusCode = 0;
    let success = false;

    const resolvedUrl = await resolveStepUrl(scenario, step.url);
    if (!resolvedUrl) {
      console.log(`[Web-Scenario] ${scenario.name} / ${step.name}: URL çözülemedi ("${step.url}") — hiçbir cihaza atanmamış bir template'in makro içeren URL'i olabilir, atlanıyor`);
      continue;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
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
    if (!success) anyStepFailed = true;

    console.log(`[Web-Scenario] ${scenario.name} / ${step.name}: ${statusCode} (beklenen ${step.expected_status_code}) - ${responseTimeMs}ms - ${success ? "OK" : "BAŞARISIZ"}`);
    // Sadece gerçek bir cihaza bağlı senaryolarda raporla — pseudo-device_id (senaryonun
    // kendi id'si) devices tablosunda yok, FK ihlaline yol açar.
    if (scenario.device_id) {
      await reportCollectorStatus(scenario.device_id, success ? "active" : "down", success ? undefined : `HTTP ${statusCode}, beklenen ${step.expected_status_code}`);
    }
  }

  // Zabbix'in web.test.fail[senaryo] trigger'ının karşılığı -- adım-bazlı metriklerden
  // ayrı, senaryo-seviyesinde tek bir "herhangi bir adım basarisiz mi" ozeti.
  await publishMetric({
    event_type: "metric", source_module: "web-collector", tenant_id: scenario.tenant_id, device_id: deviceId,
    metric_name: `web_${scenario.name.replace(/\s+/g, "_")}_any_step_failed`, timestamp, value: anyStepFailed ? 1 : 0, unit: "status"
  });
}
