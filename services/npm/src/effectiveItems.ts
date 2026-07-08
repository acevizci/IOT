export interface EffectiveItem {
  metric_name: string;
  oid: string;
  data_type: "gauge" | "counter" | "string";
  unit: string | null;
  polling_interval_seconds: number;
  is_table: boolean;
}

const CORE_SERVICE_URL = process.env.CORE_SERVICE_URL || "http://core-service:3000";

// Not: Bu servis içi (internal) bir çağrı, Gateway/auth katmanını atlıyor çünkü
// NPM Service zaten güvenli Docker network içinde, Core Service'e doğrudan erişebiliyor.
export async function fetchEffectiveItems(deviceId: string): Promise<EffectiveItem[]> {
  try {
    const response = await fetch(`${CORE_SERVICE_URL}/api/v1/devices/${deviceId}/effective-items`, {
      headers: {
        // Core Service auth middleware'i header bekliyor — internal çağrılar için
        // sahte ama tutarlı bir "system" kimliği kullanıyoruz.
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
