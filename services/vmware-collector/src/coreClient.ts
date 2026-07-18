const CORE_SERVICE_URL = process.env.CORE_SERVICE_URL || "http://core-service:3000";
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET || "";

// GÜVENİLİRLİK: core-service'e giden bir istek geçici bir ağ sorunu yüzünden
// başarısız olursa (fetch'in kendisi reddedilirse), kısa bir gecikmeyle 1 kez
// daha deneniyor -- bkz. diğer collector'lardaki aynı desen (mimari denetimde
// bulunup tüm collector'lara eklendi).
async function fetchWithRetry(url: string, options: RequestInit = {}, retries = 1): Promise<Response> {
  try {
    return await fetch(url, options);
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return fetchWithRetry(url, options, retries - 1);
  }
}

export interface VMwareDevice {
  id: string;
  tenant_id: string;
  name: string;
  ip_address: string;
  port: number | null;
  vmware_mode: "vcenter" | "esxi";
  tls_skip_verify: boolean;
}

export async function fetchVMwareDevices(): Promise<VMwareDevice[]> {
  try {
    const response = await fetchWithRetry(`${CORE_SERVICE_URL}/api/v1/internal/vmware-devices`, {
      headers: { "x-internal-secret": INTERNAL_SECRET }
    });
    if (!response.ok) return [];
    return await response.json();
  } catch (err) {
    console.error("[VMware-Collector] Cihaz listesi çekilemedi:", err);
    return [];
  }
}

// {$VMWARE_USER}/{$VMWARE_PASSWORD} makro referanslarını bu cihaz için çözer --
// SSH/SQL collector'ının KULLANDIĞI AYNI, mevcut, test edilmiş endpoint (bkz.
// exec-collector/coreClient.ts fetchResolvedConfig) -- yeni bir mekanizma DEĞİL.
export async function resolveVMwareCredentials(deviceId: string): Promise<{ username: string; password: string } | null> {
  try {
    const response = await fetchWithRetry(`${CORE_SERVICE_URL}/api/v1/internal/resolve-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ device_id: deviceId, config: { username: "{$VMWARE_USER}", password: "{$VMWARE_PASSWORD}" } })
    });
    if (!response.ok) return null;
    const resolved = await response.json();
    if (!resolved.username || !resolved.password) return null;
    return { username: resolved.username, password: resolved.password };
  } catch (err) {
    console.error(`[VMware-Collector] Kimlik bilgisi çözülemedi (device=${deviceId}):`, err);
    return null;
  }
}

export async function reportCollectorStatus(deviceId: string, status: "active" | "down", error?: string) {
  try {
    await fetchWithRetry(`${CORE_SERVICE_URL}/api/v1/internal/devices/${deviceId}/collector-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ collector_type: "vmware", status, error })
    });
  } catch (err) {
    console.error(`[VMware-Collector] Durum bildirilemedi (device=${deviceId}):`, err);
  }
}

// Bir instance (VM) izleme kaynağından kayboldu (silinmiş/taşınmış) olarak tespit
// edildiğinde, ona ait TÜM açık alarmları toplu kapatır -- bkz. index.ts'teki
// "N ardışık turda görünmeme" tespit mantığı.
export async function resolveAlertsByTag(deviceId: string, instanceTagValue: string): Promise<number> {
  try {
    const response = await fetchWithRetry(`${CORE_SERVICE_URL}/api/v1/internal/alerts/resolve-by-tag`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ device_id: deviceId, instance_tag_value: instanceTagValue })
    });
    if (!response.ok) return 0;
    const result = await response.json();
    return result.resolved_count || 0;
  } catch (err) {
    console.error(`[VMware-Collector] resolve-by-tag başarısız (device=${deviceId}, instance=${instanceTagValue}):`, err);
    return 0;
  }
}
