const CORE_SERVICE_URL = process.env.CORE_SERVICE_URL || "http://core-service:3000";
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET || "";

export interface DeviceRow {
  id: string;
  tenant_id: string;
  name: string;
  ip_address: string;
}

export interface EffectiveItem {
  metric_name: string;
  collector_type: string;
  connection_config: Record<string, any> | null; // query + {$SQL_PORT} gibi makro referansları
  unit: string | null;
}

export async function fetchAllDeviceIds(): Promise<DeviceRow[]> {
  try {
    const response = await fetch(`${CORE_SERVICE_URL}/api/v1/internal/devices`, {
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
