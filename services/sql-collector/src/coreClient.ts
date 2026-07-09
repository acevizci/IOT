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
  connection_config: Record<string, any> | null; // artık sadece "ne toplanacağı" (query)
  unit: string | null;
}

export interface DecryptedCredential {
  credential_type: "ssh_password" | "ssh_key";
  username: string;
  secret: string;
}

export interface DeviceSqlConfig {
  port?: number;
  database?: string;
  credential_id?: string;
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

export async function fetchDeviceSqlConfig(deviceId: string, collectorType: string): Promise<DeviceSqlConfig | null> {
  try {
    const response = await fetch(`${CORE_SERVICE_URL}/api/v1/internal/devices/${deviceId}/collector-config/${collectorType}`, {
      headers: { "x-internal-secret": INTERNAL_SECRET }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.error(`[SQL-Collector] SQL config çekilemedi (device=${deviceId}):`, err);
    return null;
  }
}

export async function fetchCredential(credentialId: string): Promise<DecryptedCredential | null> {
  try {
    const response = await fetch(`${CORE_SERVICE_URL}/api/v1/internal/device-credentials/${credentialId}`, {
      headers: { "x-internal-secret": INTERNAL_SECRET }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.error(`[SQL-Collector] Kimlik bilgisi çekilemedi (id=${credentialId}):`, err);
    return null;
  }
}
