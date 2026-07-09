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
  connection_config: Record<string, any> | null;
  unit: string | null;
}

// Not: Bu servis SNMP polling yapmadığı için "aktif cihaz" listesini kendi
// veritabanı sorgusuyla değil, Core Service üzerinden (internal secret ile) çeker —
// böylece cihaz durumu mantığı (active/down) tek bir yerde (NPM Service) kalır.
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
