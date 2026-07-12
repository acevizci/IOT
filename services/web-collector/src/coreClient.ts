const CORE_SERVICE_URL = process.env.CORE_SERVICE_URL || "http://core-service:3000";
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET || "";

export interface ScenarioRow {
  id: string;
  name: string;
  user_agent: string | null;
  polling_interval_seconds: number;
  tenant_id: string;
  device_id: string | null;
}

export interface ScenarioStep {
  step_order: number;
  name: string;
  url: string;
  expected_status_code: number;
}

export async function fetchAllScenarios(): Promise<ScenarioRow[]> {
  try {
    const response = await fetch(`${CORE_SERVICE_URL}/api/v1/internal/web-scenarios`, {
      headers: { "x-internal-secret": INTERNAL_SECRET }
    });
    if (!response.ok) return [];
    return await response.json();
  } catch (err) {
    console.error("[Web-Collector] Senaryo listesi çekilemedi:", err);
    return [];
  }
}

export async function fetchScenarioSteps(scenarioId: string): Promise<ScenarioStep[]> {
  try {
    const response = await fetch(`${CORE_SERVICE_URL}/api/v1/internal/web-scenarios/${scenarioId}/steps`, {
      headers: { "x-internal-secret": INTERNAL_SECRET }
    });
    if (!response.ok) return [];
    return await response.json();
  } catch (err) {
    console.error(`[Web-Collector] Adımlar çekilemedi (scenario=${scenarioId}):`, err);
    return [];
  }
}

export async function reportCollectorStatus(deviceId: string, status: "active" | "down", error?: string) {
  try {
    await fetch(`${CORE_SERVICE_URL}/api/v1/internal/devices/${deviceId}/collector-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ collector_type: "web_scenario", status, error })
    });
  } catch (err) {
    console.error(`[Web-Collector] collector-status bildirimi başarısız (device=${deviceId}):`, err);
  }
}
