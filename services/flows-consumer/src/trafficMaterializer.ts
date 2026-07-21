import { queryTrafficSummary } from "./clickhouse.js";
import { getAllTenantIds, getIpToDeviceIdMap, upsertTrafficLink } from "./db.js";

// RCA Confidence Motoru (madde 3): NetFlow verisi ClickHouse'da, ama recursive CTE
// tabanlı kök-neden zincir analizi Postgres'te çalışıyor -- iki farklı DB motoru
// aynı graf gezinmesinde birleşemez. Çözüm (LLDP keşfindeki AYNI periyodik
// materyalizasyon deseni): periyodik olarak ClickHouse'daki yoğun trafik
// ilişkilerini Postgres'teki traffic_links tablosuna UPSERT ediyoruz -- böylece
// core-service'teki recursive CTE bunu device_links/VMware hiyerarşisiyle AYNI
// sorguda kullanabilir.
export async function materializeTrafficLinks(): Promise<void> {
  const tenantIds = await getAllTenantIds();
  for (const tenantId of tenantIds) {
    try {
      const summary = await queryTrafficSummary(tenantId);
      if (summary.length === 0) continue;
      const ipToDeviceId = await getIpToDeviceIdMap(tenantId);
      let matched = 0;
      for (const row of summary) {
        const deviceAId = ipToDeviceId[row.src_ip];
        const deviceBId = ipToDeviceId[row.dst_ip];
        if (deviceAId && deviceBId && deviceAId !== deviceBId) {
          await upsertTrafficLink(tenantId, deviceAId, deviceBId, row.total_bytes);
          matched++;
        }
      }
      if (matched > 0) console.log(`[TrafficMaterializer] Tenant ${tenantId}: ${matched} trafik ilişkisi güncellendi.`);
    } catch (err) {
      console.error(`[TrafficMaterializer] Tenant ${tenantId} için hata:`, err);
    }
  }
}
