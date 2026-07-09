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
  connection_config: Record<string, any> | null; // command + {$SSH_PORT} gibi makro referansları
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
    console.error("[Exec-Collector] Cihaz listesi çekilemedi:", err);
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
    console.error(`[Exec-Collector] Effective items çekilemedi (device=${deviceId}):`, err);
    return [];
  }
}

// connection_config içindeki {$SSH_PORT}/{$SSH_USER}/{$SSH_PASSWORD} gibi makro referanslarını
// bu cihaz için çözer — host hâlâ device.ip_address'ten gelir, makro sistemine hiç girmez.
// Eskiden device_collector_configs + device_credentials'in yaptığı işi Core Service'teki
// tek bir endpoint (resolve-config) üstleniyor.
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
    console.error(`[Exec-Collector] Bağlantı bilgisi çözülemedi (device=${deviceId}):`, err);
    return null;
  }
}
