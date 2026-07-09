export interface EffectiveItem {
  metric_name: string;
  oid: string | null;
  data_type: "gauge" | "counter" | "string";
  unit: string | null;
  polling_interval_seconds: number;
  is_table: boolean;
  formula: string | null;
  formula_oids: Record<string, string> | null;
}

const CORE_SERVICE_URL = process.env.CORE_SERVICE_URL || "http://core-service:3000";

export async function fetchEffectiveItems(deviceId: string): Promise<EffectiveItem[]> {
  try {
    const response = await fetch(`${CORE_SERVICE_URL}/api/v1/devices/${deviceId}/effective-items`, {
      headers: {
        "x-auth-tenant-id": "internal",
        "x-auth-user-id": "npm-service",
        "x-auth-role": "system"
      }
    });
    if (!response.ok) return [];
    return await response.json();
  } catch (err) {
    console.error(`[NPM] Effective items çekilemedi (device=${deviceId}):`, err);
    return [];
  }
}
