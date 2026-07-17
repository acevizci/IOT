const CORE_SERVICE_URL = process.env.CORE_SERVICE_URL || "http://core-service:3000";
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET || "";

export interface DeviceRow {
  id: string;
  tenant_id: string;
  name: string;
  ip_address: string;
}

export interface EffectiveItem {
  id: string;
  metric_name: string;
  collector_type: string;
  connection_config: Record<string, any> | null; // query + {$SQL_PORT} gibi makro referansları
  unit: string | null;
}

export async function fetchAllDeviceIds(): Promise<DeviceRow[]> {
  try {
    // collector_type=sql: Core Service, bu cihazın SQL interface'i tanımlıysa oradan,
    // yoksa devices.ip_address'ten (eski model) IP döner.
    const response = await fetch(`${CORE_SERVICE_URL}/api/v1/internal/devices?collector_type=sql`, {
      headers: { "x-internal-secret": INTERNAL_SECRET }
    });
    if (!response.ok) return [];
    return await response.json();
  } catch (err) {
    console.error("[SQL-Collector] Cihaz listesi çekilemedi:", err);
    return [];
  }
}

export async function fetchEffectiveItems(deviceId: string): Promise<EffectiveItem[]> {
  try {
    const response = await fetch(`${CORE_SERVICE_URL}/api/v1/devices/${deviceId}/effective-items`, {
      headers: { "x-internal-secret": INTERNAL_SECRET }
    });
    if (!response.ok) return [];
    return await response.json();
  } catch (err) {
    console.error(`[SQL-Collector] Effective items çekilemedi (device=${deviceId}):`, err);
    return [];
  }
}

// connection_config içindeki {$SQL_PORT}/{$SQL_DATABASE}/{$SQL_USER}/{$SQL_PASSWORD} gibi
// makro referanslarını bu cihaz için çözer. Eskiden device_collector_configs +
// device_credentials'in yaptığı işi Core Service'teki tek bir endpoint üstleniyor.
export async function fetchResolvedConfig(deviceId: string, config: Record<string, any>): Promise<Record<string, any> | null> {
  try {
    const response = await fetch(`${CORE_SERVICE_URL}/api/v1/internal/resolve-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ device_id: deviceId, config })
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.error(`[SQL-Collector] Bağlantı bilgisi çözülemedi (device=${deviceId}):`, err);
    return null;
  }
}

export async function reportCollectorStatus(deviceId: string, status: "active" | "down", error?: string, collectorType: string = "sql_postgres") {
  try {
    await fetch(`${CORE_SERVICE_URL}/api/v1/internal/devices/${deviceId}/collector-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ collector_type: collectorType, status, error })
    });
  } catch (err) {
    console.error(`[SQL-Collector] collector-status bildirimi başarısız (device=${deviceId}):`, err);
  }
}

// Faz Queue-2: per-item zamanlama, Core Service'in schedule endpoint'leri üzerinden
// (aynı desen npm-service/exec-collector'da kuruldu).
export async function reconcileSchedule(collectorType: string) {
  try {
    await fetch(`${CORE_SERVICE_URL}/api/v1/internal/schedule/reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ collector_type: collectorType })
    });
  } catch (err) {
    console.error(`[SQL-Collector] Schedule reconcile başarısız (collector_type=${collectorType}):`, err);
  }
}

export interface DueScheduleEntry {
  device_id: string;
  resource_type: string;
  resource_id: string;
}
export async function fetchDueSchedule(collectorType: string, limit = 500): Promise<DueScheduleEntry[]> {
  try {
    const response = await fetch(
      `${CORE_SERVICE_URL}/api/v1/internal/schedule/due?collector_type=${collectorType}&limit=${limit}`,
      { headers: { "x-internal-secret": INTERNAL_SECRET } }
    );
    if (!response.ok) return [];
    return await response.json();
  } catch (err) {
    console.error(`[SQL-Collector] Due schedule çekilemedi (collector_type=${collectorType}):`, err);
    return [];
  }
}

export async function markScheduleCollected(deviceId: string, resourceType: string, resourceId: string, durationMs: number, error?: string) {
  try {
    await fetch(`${CORE_SERVICE_URL}/api/v1/internal/schedule/mark-collected`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ device_id: deviceId, resource_type: resourceType, resource_id: resourceId, duration_ms: durationMs, error })
    });
  } catch (err) {
    console.error(`[SQL-Collector] mark-collected başarısız (device=${deviceId}, resource=${resourceId}):`, err);
  }
}

// Performans DÜZELTMESİ: önceden HER item için AYRI bir istek atılıyordu (npm-service'te
// zaten çözülmüş aynı sorun). Artık npm-service'teki referans desenle aynı şekilde,
// tick sonunda toplanan TÜM item'lar TEK bir batch istekte gönderiliyor.
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
    await fetch(`${CORE_SERVICE_URL}/api/v1/internal/schedule/mark-collected-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ entries })
    });
  } catch (err) {
    console.error(`[SQL-Collector] mark-collected-batch başarısız (${entries.length} kayıt):`, err);
  }
}
