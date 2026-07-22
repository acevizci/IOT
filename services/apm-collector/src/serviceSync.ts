// APM Adım 6: her yeni servis+host çifti görüldüğünde core-service'in
// /api/v1/internal/apm-sync/service endpoint'ini çağırıp servisi devices
// tablosuna kaydeder ve host'a bağlar -- computeRootCauseCandidates'ın
// adjacency CTE'si bu ilişkiyi otomatik olarak RCA zincirine dahil eder.
//
// nta-service/src/index.ts'teki deviceCache ile AYNI throttle deseni: her
// span için bu endpoint'i çağırmak (saniyede onlarca kez) core-service'e
// gereksiz yük bindirir -- (tenantId, serviceName, hostName) üçlüsü başına
// belirli bir süre (varsayılan 5 dakika) sonra tekrar senkronize ediyoruz.

const CORE_SERVICE_URL = process.env.CORE_SERVICE_URL || "http://core-service:3000";
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET || "";
const SYNC_TTL_MS = Number(process.env.APM_SERVICE_SYNC_TTL_MS) || 5 * 60 * 1000;

const lastSyncedAt = new Map<string, number>();

export async function syncServiceIfNeeded(tenantId: string, serviceName: string, hostName: string | undefined): Promise<void> {
  const cacheKey = `${tenantId}:${serviceName}:${hostName || ""}`;
  const last = lastSyncedAt.get(cacheKey);
  if (last && Date.now() - last < SYNC_TTL_MS) return;

  try {
    const res = await fetch(`${CORE_SERVICE_URL}/api/v1/internal/apm-sync/service`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ tenant_id: tenantId, service_name: serviceName, host_name: hostName })
    });
    if (!res.ok) {
      console.error(`[ApmCollector] apm-sync/service başarısız: ${res.status} ${await res.text()}`);
      return; // TTL'i güncellemiyoruz -- bir sonraki span'de tekrar denensin.
    }
    lastSyncedAt.set(cacheKey, Date.now());
  } catch (err) {
    console.error("[ApmCollector] apm-sync/service çağrı hatası (yok sayıldı):", (err as Error).message);
  }
}
