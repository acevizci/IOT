import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.POSTGRES_HOST || "postgres",
  port: Number(process.env.POSTGRES_PORT) || 5432,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  max: 5
});

export interface DeviceRow {
  id: string;
  tenant_id: string;
  name: string;
  ip_address: string;
  snmp_config: { community?: string; port?: number } | null;
  attributes: Record<string, any> | null;
}

// "active" veya "down" olan, ve SNMP polling'i devre dışı bırakılmamış cihazlar izlenir.
// attributes.monitoring_type = 'netflow_only' olan cihazlar (sadece trafik export eden,
// SNMP agent'ı olmayan exporter'lar) bu listeye hiç girmez.
export async function getActiveDevices(): Promise<DeviceRow[]> {
  // SNMP interface'i device_interfaces'ten öncelikli olarak alınır; tanımlı değilse
  // devices.ip_address'e geri düşülür (geriye dönük uyumluluk — Faz 8.5 öncesi cihazlar).
  // '0.0.0.0', agent-tabanlı (Faz E) cihazların yer tutucu IP'si — bunların gerçek bir
  // SNMP interface'i yoksa hiç SNMP polling'ine girmemesi lazım (aksi halde her zaman
  // timeout alıp yanlışlıkla 'down' işaretlenirler).
  const result = await pool.query(
    // KRİTİK DÜZELTME (Queue görünürlüğü sırasında bulundu): netflow_only cihazlar
    // önceden BU sorgudan tamamen hariç tutuluyordu -- ama npm-service SNMP DIŞINDA
    // http_json/ssh_exec/tcp_port/icmp_ping item'larını da bu döngüde işliyor. Bu
    // filtre, netflow_only bir cihazın gerçek http_json item'larının da SESSİZCE hiç
    // toplanmamasına yol açıyordu (Queue'da sonsuza dek "gecikmiş" görünüyorlardı).
    // Artık cihaz döngüye giriyor, SNMP-özel atlama index.ts'te (attributes okunarak)
    // yapılıyor -- diğer protokoller etkilenmiyor.
    `SELECT d.id, d.tenant_id, d.name,
            COALESCE(di.ip_address, host(d.ip_address)) as ip_address,
            d.snmp_config, d.attributes
     FROM devices d
     LEFT JOIN device_interfaces di ON di.device_id = d.id AND di.interface_type = 'snmp'
     WHERE d.status IN ('active', 'down', 'unknown')
       AND (di.ip_address IS NOT NULL OR host(d.ip_address) != '0.0.0.0'
            OR COALESCE(d.attributes->>'monitoring_type', 'snmp') = 'netflow_only')`
  );
  return result.rows;
}

export async function updateDeviceStatus(deviceId: string, status: "active" | "down") {
  await pool.query(`UPDATE devices SET status = $1 WHERE id = $2 AND status != $1`, [status, deviceId]);
}

// SNMP collector'ının kendi ayrı erişilebilirlik durumunu Core Service'e bildirir
// (device_collector_status tablosu — Zabbix'in her interface-tipi için ayrı durum
// modeli). Mevcut updateDeviceStatus'a EK olarak çağrılır, onu değiştirmez.
const CORE_SERVICE_URL = process.env.CORE_SERVICE_URL || "http://core-service:3000";
export async function reportCollectorStatus(deviceId: string, status: "active" | "down", error?: string) {
  try {
    await fetch(`${CORE_SERVICE_URL}/api/v1/internal/devices/${deviceId}/collector-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET || "" },
      body: JSON.stringify({ collector_type: "snmp", status, error })
    });
  } catch (err) {
    console.error(`[NPM] collector-status bildirimi başarısız (device=${deviceId}):`, err);
  }
}

// Faz Queue-1: per-item zamanlama, Core Service'in /api/v1/internal/schedule/*
// endpoint'leri UZERINDEN (DOGRUDAN DB erisimi degil -- bu, koddaki mevcut
// reportCollectorStatus deseniyle tutarli: collector'lar DB semasindan izole,
// SADECE Core Service'in sundugu sinirli API'yi kullanir).
//
// NOT: Bu tablo/endpoint'ler PARALEL bir oturumda ZATEN yazilmisti (Core Service
// tarafinda) -- bu dosyadaki onceki versiyon (dogrudan pool.query ile SQL fonksiyonu
// cagiran) o calismadan HABERSIZ, ayri bir yaklasimla yazilmisti. Ikisi cakisiyordu;
// Core Service API yaklasimi (kod tekrarini onlemesi, collector'lari DB semasindan
// izole etmesi nedeniyle) tercih edilip bu dosya ona gore yeniden yazildi.

// Bu collector_type'a ait, henuz zamanlamasi olmayan (template_item, device)
// ciftlerini Core Service'e ekletir (idempotent, self-healing).
export async function reconcileSchedule(collectorType: string) {
  try {
    await fetch(`${CORE_SERVICE_URL}/api/v1/internal/schedule/reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET || "" },
      body: JSON.stringify({ collector_type: collectorType })
    });
  } catch (err) {
    console.error(`[NPM] Schedule reconcile başarısız (collector_type=${collectorType}):`, err);
  }
}

export interface DueScheduleEntry {
  device_id: string;
  resource_type: string;
  resource_id: string;
}
// Su an "vadesi gelmis" (next_due_at <= now()) kayitlari Core Service'ten ceker.
export async function fetchDueSchedule(collectorType: string, limit = 500): Promise<DueScheduleEntry[]> {
  try {
    const response = await fetch(
      `${CORE_SERVICE_URL}/api/v1/internal/schedule/due?collector_type=${collectorType}&limit=${limit}`,
      { headers: { "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET || "" } }
    );
    if (!response.ok) return [];
    return await response.json();
  } catch (err) {
    console.error(`[NPM] Due schedule çekilemedi (collector_type=${collectorType}):`, err);
    return [];
  }
}

// Toplanmaya CALISILAN bir item'in zamanlamasini ilerletir (basari/hata farketmeksizin).
export async function markScheduleCollected(deviceId: string, resourceType: string, resourceId: string, durationMs: number, error?: string) {
  try {
    await fetch(`${CORE_SERVICE_URL}/api/v1/internal/schedule/mark-collected`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET || "" },
      body: JSON.stringify({ device_id: deviceId, resource_type: resourceType, resource_id: resourceId, duration_ms: durationMs, error })
    });
  } catch (err) {
    console.error(`[NPM] mark-collected başarısız (device=${deviceId}, resource=${resourceId}):`, err);
  }
}

// Performans: HER item icin AYRI istek yerine, tick sonunda toplanan TUM item'lari
// TEK bir batch istekte gonderir.
export interface MarkCollectedEntry {
  device_id: string;
  resource_type: string;
  resource_id: string;
  duration_ms?: number;
  error?: string;
}
export async function markScheduleCollectedBatch(entries: MarkCollectedEntry[]) {
  if (entries.length === 0) return;
  try {
    await fetch(`${CORE_SERVICE_URL}/api/v1/internal/schedule/mark-collected-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET || "" },
      body: JSON.stringify({ entries })
    });
  } catch (err) {
    console.error(`[NPM] mark-collected-batch başarısız (${entries.length} kayıt):`, err);
  }
}
