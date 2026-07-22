import { discoverDevice, pingHost, SnmpCredentials } from "./discovery.js";
import { redisClient } from "./redisClient.js";

export interface ScanResult {
  ip: string;
  reachable: boolean;
  sysDescr?: string;
  interfaceCount?: number;
}

export interface ScanJob {
  jobId: string;
  status: "running" | "completed" | "failed";
  // FAZ 1 (ping): tüm aralık hızlıca taranır, canlı host'lar bulunur.
  // FAZ 2 (snmp): SADECE ping'e cevap veren host'larda SNMP denenir.
  phase: "ping" | "snmp";
  pingTotal: number;
  pingScanned: number;
  snmpTotal: number;
  snmpScanned: number;
  found: ScanResult[];
  startedAt: string;
  completedAt?: string;
  error?: string;
}

const JOB_TTL_SECONDS = 3600; // sonuçlar 1 saat sonra otomatik silinir (kalıcı sonuçlar discovery_candidates'ta -- bkz. callback)

function jobKey(jobId: string) {
  return `discovery:job:${jobId}`;
}

export async function getJob(jobId: string): Promise<ScanJob | null> {
  const data = await redisClient.get(jobKey(jobId));
  return data ? JSON.parse(data) : null;
}

async function saveJob(job: ScanJob) {
  await redisClient.set(jobKey(job.jobId), JSON.stringify(job), { EX: JOB_TTL_SECONDS });
}

// Tek bir CIDR'ı (örn. "192.168.1.0/24") IP listesine çevirir. Ping ön-filtresi
// sayesinde artık /24 zorunluluğu YOK (eskiden büyük taramalar network'ü
// boğduğu için /24-/32 ile sınırlıydı) -- toplam adres sayısı ayrıca
// expandCidrRanges'te MAX_SCAN_ADDRESSES ile sınırlanıyor.
function expandCidr(cidr: string): string[] {
  const [base, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);

  if (!base || Number.isNaN(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Geçersiz CIDR: "${cidr}"`);
  }
  const parts = base.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Geçersiz CIDR: "${cidr}"`);
  }

  const hostBits = 32 - prefix;
  const hostCount = Math.pow(2, hostBits);

  const baseNum = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  const networkNum = baseNum & (~0 << hostBits);

  const ips: string[] = [];
  // Network ve broadcast adreslerini atla (host aralığı: 1..hostCount-2)
  const start = hostCount > 2 ? 1 : 0;
  const end = hostCount > 2 ? hostCount - 1 : hostCount;

  for (let i = start; i < end; i++) {
    const num = networkNum + i;
    const ip = [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join(".");
    ips.push(ip);
  }

  return ips;
}

// Tek taramada izin verilen toplam adres sayısı tavanı -- ping ön-filtresi
// sayesinde artık tek /24 zorunluluğu yok, ama sınırsız da olmamalı (yanlışlıkla
// bir /8 girilmesine karşı bir güvenlik ağı). ~/20'ye karşılık gelen 4096
// varsayılanı, çoğu veri merkezi VLAN'ı için tek kuralda yeterli.
const MAX_SCAN_ADDRESSES = Number(process.env.DISCOVERY_MAX_ADDRESSES) || 4096;

export function expandCidrRanges(cidrs: string[]): string[] {
  if (cidrs.length === 0) throw new Error("En az bir CIDR aralığı belirtilmeli");

  const seen = new Set<string>();
  const ips: string[] = [];
  for (const cidr of cidrs) {
    for (const ip of expandCidr(cidr.trim())) {
      if (!seen.has(ip)) {
        seen.add(ip);
        ips.push(ip);
      }
    }
  }

  if (ips.length > MAX_SCAN_ADDRESSES) {
    throw new Error(
      `Toplam ${ips.length} adres istendi, tek taramada izin verilen üst sınır ${MAX_SCAN_ADDRESSES} ` +
      `(DISCOVERY_MAX_ADDRESSES ortam değişkeniyle ayarlanabilir)`
    );
  }

  return ips;
}

const PING_CONCURRENCY = 100; // ping çok ucuz, SNMP'den çok daha yüksek eşzamanlılık güvenli
const SNMP_CONCURRENCY = 20;

export interface ScanCallback {
  tenantId: string;
  ruleId: string;
}

export async function startSubnetScan(
  cidrs: string[],
  credentials: SnmpCredentials,
  jobId: string,
  onComplete?: (job: ScanJob, callback: ScanCallback) => Promise<void>,
  callback?: ScanCallback
) {
  const ips = expandCidrRanges(cidrs);

  const job: ScanJob = {
    jobId,
    status: "running",
    phase: "ping",
    pingTotal: ips.length,
    pingScanned: 0,
    snmpTotal: 0,
    snmpScanned: 0,
    found: [],
    startedAt: new Date().toISOString()
  };
  await saveJob(job);

  // Arka planda çalışsın, HTTP isteğini bloklamayalım
  (async () => {
    // FAZ 1: hızlı ICMP ping sweep.
    const pingQueue = [...ips];
    const liveIps: string[] = [];

    async function pingWorker() {
      while (pingQueue.length > 0) {
        const ip = pingQueue.shift();
        if (!ip) break;
        const alive = await pingHost(ip);
        job.pingScanned++;
        if (alive) liveIps.push(ip);
        if (job.pingScanned % 20 === 0 || job.pingScanned === job.pingTotal) await saveJob(job);
      }
    }
    await Promise.all(Array.from({ length: PING_CONCURRENCY }, () => pingWorker()));

    // GÜVENLİK AĞI: ping'e HİÇ cevap gelmediyse (0 canlı host), bu muhtemelen
    // ICMP'nin ağda/firewall'da engellendiği anlamına gelir -- SNMP çalışabilen
    // bir cihazı sessizce "hiçbir şey yok" diye raporlamak yerine, bu durumda
    // ping ön-filtresini ATLAYIP tüm aralığı doğrudan SNMP ile deniyoruz (eski
        // davranışa geri dönüş, sadece bu kaçış senaryosunda).
    const snmpTargets = liveIps.length > 0 ? liveIps : (job.pingTotal > 0 ? ips : []);

    // FAZ 2: SNMP keşfi -- sadece canlı (veya ping tamamen engellenmişse tüm) host'larda.
    job.phase = "snmp";
    job.snmpTotal = snmpTargets.length;
    await saveJob(job);

    const snmpQueue = [...snmpTargets];
    async function snmpWorker() {
      while (snmpQueue.length > 0) {
        const ip = snmpQueue.shift();
        if (!ip) break;

        try {
          const result = await discoverDevice(ip, credentials);
          job.snmpScanned++;
          if (result.reachable) {
            job.found.push({
              ip,
              reachable: true,
              sysDescr: result.sysDescr,
              interfaceCount: result.interfaceCount
            });
          }
        } catch {
          job.snmpScanned++;
        }

        if (job.snmpScanned % 5 === 0 || job.snmpScanned === job.snmpTotal) await saveJob(job);
      }
    }
    await Promise.all(Array.from({ length: SNMP_CONCURRENCY }, () => snmpWorker()));

    job.status = "completed";
    job.completedAt = new Date().toISOString();
    await saveJob(job);

    if (onComplete && callback) {
      await onComplete(job, callback);
    }
  })().catch(async (err) => {
    console.error("[SubnetScan] Tarama hatası:", err);
    job.status = "failed";
    job.error = err.message;
    await saveJob(job);
  });

  return { jobId, total: ips.length };
}
