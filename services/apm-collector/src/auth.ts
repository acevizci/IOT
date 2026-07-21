// VARSAYIM (henüz canlı doğrulanmadı): core-service'in mevcut
// /api/v1/internal/verify-api-token endpoint'i bir API token alıp tenantId
// döndürüyor -- bu, apm-collector'ın YENİ bir auth mekanizması icat etmek
// yerine mevcut API token altyapısını (services/core/src/apiTokens.js) yeniden
// kullanmasını sağlıyor. Gerçek request/response şeklini canlı test ederek
// doğrulayacağız, gerekirse burası düzeltilecek.

const CORE_SERVICE_URL = process.env.CORE_SERVICE_URL || "http://core-service:3000";
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET || "";

export async function resolveTenantFromApiToken(apiToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${CORE_SERVICE_URL}/api/v1/internal/verify-api-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ token: apiToken })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.tenantId || data?.tenant_id || null;
  } catch (err) {
    console.error("[ApmCollector] Token doğrulama hatası:", (err as Error).message);
    return null;
  }
}
