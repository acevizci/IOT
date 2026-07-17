const CORE_SERVICE_URL = process.env.CORE_SERVICE_URL || "http://core-service:3000";
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET || "";

// GÜVENİLİRLİK: core-service'e giden bir istek geçici bir ağ sorunu/kısa
// kesinti yüzünden başarısız olursa (fetch'in kendisi reddedilirse -- bağlantı
// reddi/timeout gibi, HTTP 4xx/5xx durum kodları DEĞİL), önceden hiç yeniden
// denenmeden o turun verisi kaybediliyordu. Şimdi kısa bir gecikmeyle (300ms)
// 1 kez daha deneniyor -- gerçek bir kesinti (core-service uzun süre kapalı)
// için hâlâ bir sonraki tur beklenir, sonsuz retry yapılmaz.
async function fetchWithRetry(url: string, options: RequestInit = {}, retries = 1): Promise<Response> {
  try {
    return await fetch(url, options);
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return fetchWithRetry(url, options, retries - 1);
  }
}


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
    const response = await fetchWithRetry(`${CORE_SERVICE_URL}/api/v1/internal/web-scenarios`, {
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
    const response = await fetchWithRetry(`${CORE_SERVICE_URL}/api/v1/internal/web-scenarios/${scenarioId}/steps`, {
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
    await fetchWithRetry(`${CORE_SERVICE_URL}/api/v1/internal/devices/${deviceId}/collector-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ collector_type: "web_scenario", status, error })
    });
  } catch (err) {
    console.error(`[Web-Collector] collector-status bildirimi başarısız (device=${deviceId}):`, err);
  }
}

// Senaryo gerçek bir cihaza bağlıysa (scenario.device_id doluysa), o cihazın "web"
// interface'ini (IP+port) çeker — Faz 8.5 çoklu-interface modeliyle tutarlılık için.
export async function fetchDeviceWebInterface(deviceId: string): Promise<{ ip_address: string; port: number | null } | null> {
  try {
    const response = await fetchWithRetry(`${CORE_SERVICE_URL}/api/v1/internal/devices/${deviceId}/interface/web`, {
      headers: { "x-internal-secret": INTERNAL_SECRET }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.error(`[Web-Collector] Web interface çekilemedi (device=${deviceId}):`, err);
    return null;
  }
}

// Adım URL'sindeki {$WEB.URL} gibi çözülmemiş makro referanslarını, SSH/SQL collector'ların
// kullandığı aynı mekanizmayla (resolve-config) bu senaryonun bağlı olduğu cihaz için çözer.
export async function resolveUrlMacros(deviceId: string, rawUrl: string): Promise<string | null> {
  try {
    const response = await fetchWithRetry(`${CORE_SERVICE_URL}/api/v1/internal/resolve-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ device_id: deviceId, config: { url: rawUrl } })
    });
    if (!response.ok) return null;
    const resolved = await response.json();
    return resolved.url || null;
  } catch (err) {
    console.error(`[Web-Collector] URL makroları çözülemedi (device=${deviceId}):`, err);
    return null;
  }
}

// Faz Queue-2 (son collector): per-item/senaryo zamanlama, Core Service'in
// schedule endpoint'leri üzerinden (aynı desen npm-service/exec-collector/
// sql-collector'da kuruldu). Web senaryoları resource_type='web_scenario' olarak
// zamanlanır -- her senaryonun kendi id'si resource_id, cihaz atanmamış
// senaryolar (device_id null) reconcile tarafından zaten hiç eklenmez.
export async function reconcileSchedule() {
  try {
    await fetchWithRetry(`${CORE_SERVICE_URL}/api/v1/internal/schedule/reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ collector_type: "web_scenario" })
    });
  } catch (err) {
    console.error("[Web-Collector] Schedule reconcile başarısız:", err);
  }
}

export interface DueScheduleEntry {
  device_id: string;
  resource_type: string;
  resource_id: string;
}
export async function fetchDueSchedule(limit = 500): Promise<DueScheduleEntry[]> {
  try {
    const response = await fetchWithRetry(
      `${CORE_SERVICE_URL}/api/v1/internal/schedule/due?collector_type=web_scenario&limit=${limit}`,
      { headers: { "x-internal-secret": INTERNAL_SECRET } }
    );
    if (!response.ok) return [];
    return await response.json();
  } catch (err) {
    console.error("[Web-Collector] Due schedule çekilemedi:", err);
    return [];
  }
}

export async function markScheduleCollected(deviceId: string, resourceId: string, durationMs: number, error?: string) {
  try {
    await fetchWithRetry(`${CORE_SERVICE_URL}/api/v1/internal/schedule/mark-collected`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ device_id: deviceId, resource_type: "web_scenario", resource_id: resourceId, duration_ms: durationMs, error })
    });
  } catch (err) {
    console.error(`[Web-Collector] mark-collected başarısız (scenario=${resourceId}):`, err);
  }
}

// Performans DÜZELTMESİ: önceden HER senaryo için AYRI bir istek atılıyordu (npm-service'te
// zaten çözülmüş aynı sorun). Artık npm-service'teki referans desenle aynı şekilde,
// tick sonunda toplanan TÜM senaryolar TEK bir batch istekte gönderiliyor.
export interface MarkCollectedEntry {
  device_id: string;
  resource_type: string;
  resource_id: string;
  duration_ms?: number;
  error?: string;
}
export async function markScheduleCollectedBatch(entries: MarkCollectedEntry[]) {
  if (entries.length === 0) return;
  try {
    await fetchWithRetry(`${CORE_SERVICE_URL}/api/v1/internal/schedule/mark-collected-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ entries })
    });
  } catch (err) {
    console.error(`[Web-Collector] mark-collected-batch başarısız (${entries.length} kayıt):`, err);
  }
}
