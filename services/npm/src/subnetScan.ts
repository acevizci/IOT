import { discoverDevice } from "./discovery.js";
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
  total: number;
  scanned: number;
  found: ScanResult[];
  startedAt: string;
  completedAt?: string;
}

const JOB_TTL_SECONDS = 3600; // sonuçlar 1 saat sonra otomatik silinir

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

// CIDR notasyonunu (örn. "192.168.1.0/24") IP listesine çevirir.
// Basitlik için /24 ve üzeri (daha küçük) subnet'leri destekliyoruz —
// büyük taramalar (örn. /16) network'ü boğar, kasıtlı olarak sınırlıyoruz.
function expandCidr(cidr: string): string[] {
  const [base, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);

  if (prefix < 24 || prefix > 32) {
    throw new Error("Sadece /24 ile /32 arası subnet aralıkları destekleniyor (network'ü korumak için)");
  }

  const parts = base.split(".").map(Number);
  const hostBits = 32 - prefix;
  const hostCount = Math.pow(2, hostBits);

  const baseNum = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  const networkNum = baseNum & (~0 << hostBits);

  const ips: string[] = [];
  // Network ve broadcast adreslerini atla (host aralığı: 1..hostCount-2)
  const start = hostCount > 1 ? 1 : 0;
  const end = hostCount > 1 ? hostCount - 1 : hostCount;

  for (let i = start; i < end; i++) {
    const num = networkNum + i;
    const ip = [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join(".");
    ips.push(ip);
  }

  return ips;
}

const CONCURRENCY = 20;

export async function startSubnetScan(cidr: string, community: string, jobId: string) {
  const ips = expandCidr(cidr);

  const job: ScanJob = {
    jobId,
    status: "running",
    total: ips.length,
    scanned: 0,
    found: [],
    startedAt: new Date().toISOString()
  };
  await saveJob(job);

  // Arka planda çalışsın, HTTP isteğini bloklamayalım
  (async () => {
    const queue = [...ips];

    async function worker() {
      while (queue.length > 0) {
        const ip = queue.shift();
        if (!ip) break;

        try {
          const result = await discoverDevice(ip, community);
          job.scanned++;
          if (result.reachable) {
            job.found.push({
              ip,
              reachable: true,
              sysDescr: result.sysDescr,
              interfaceCount: result.interfaceCount
            });
          }
        } catch {
          job.scanned++;
        }

        // Periyodik olarak ilerlemeyi kaydet (her IP'de değil, performans için her 5'te bir)
        if (job.scanned % 5 === 0 || job.scanned === job.total) {
          await saveJob(job);
        }
      }
    }

    const workers = Array.from({ length: CONCURRENCY }, () => worker());
    await Promise.all(workers);

    job.status = "completed";
    job.completedAt = new Date().toISOString();
    await saveJob(job);
  })().catch(async (err) => {
    console.error("[SubnetScan] Tarama hatası:", err);
    job.status = "failed";
    await saveJob(job);
  });

  return { jobId, total: ips.length };
}
