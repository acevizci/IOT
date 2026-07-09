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
  connection_config: Record<string, any> | null; // artık sadece "ne toplanacağı" (command, parse_pattern)
  unit: string | null;
}

export interface DecryptedCredential {
  credential_type: "ssh_password" | "ssh_key";
  username: string;
  secret: string;
}

export interface DeviceSshConfig {
  port?: number;
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

// Cihazın SSH bağlantı bilgisini (host artık device.ip_address'ten, port/credential_id buradan) çeker
export async function fetchDeviceSshConfig(deviceId: string): Promise<DeviceSshConfig | null> {
  try {
    const response = await fetch(`${CORE_SERVICE_URL}/api/v1/internal/devices/${deviceId}/collector-config/ssh_exec`, {
      headers: { "x-internal-secret": INTERNAL_SECRET }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.error(`[Exec-Collector] SSH config çekilemedi (device=${deviceId}):`, err);
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
    console.error(`[Exec-Collector] Kimlik bilgisi çekilemedi (id=${credentialId}):`, err);
    return null;
  }
}
