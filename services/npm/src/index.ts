import { getActiveDevices, updateDeviceStatus, reportCollectorStatus } from "./db.js";
import { connectRedis } from "./redisClient.js";
import { pollDevice, pollEffectiveItems, pollTableItem } from "./snmpPoller.js";
import { fetchEffectiveItems } from "./effectiveItems.js";
import { pollMultiProtocolItem, pollMasterWithDependents } from "./multiProtocolCollectors.js";
import Fastify from "fastify";
import { z } from "zod";
import { discoverDevice } from "./discovery.js";
import { startSubnetScan, getJob } from "./subnetScan.js";
import { randomUUID } from "crypto";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 60000;
const FAILURE_THRESHOLD = Number(process.env.FAILURE_THRESHOLD) || 2;
// Diğer YZ'nin bulduğu asimetri düzeltmesi: önceden down->active geçişi TEK başarılı
// pollde anında oluyordu, active->down ise 2 art arda başarısızlık gerektiriyordu.
// Sınırda (her ikinci pollde cevap veren) bir cihaz sürekli active<->down arası
// salınabilirdi (flapping). Şimdi ikisi de simetrik, art arda sayaç gerektiriyor.
const SUCCESS_THRESHOLD = Number(process.env.SUCCESS_THRESHOLD) || 2;

// Cihaz bazlı art arda başarısızlık sayacı (flapping'i önlemek için — madde: alarm motorunda çözdüğümüz aynı problem)
const consecutiveFailures = new Map<string, number>();
const consecutiveSuccesses = new Map<string, number>();

async function pollAllDevices() {
  const devices = await getActiveDevices();
  console.log(`[NPM] ${devices.length} cihaz polling ediliyor...`);

  for (const device of devices) {
    const isHealthy = await pollDevice(device);

    if (isHealthy) {
      // Template üzerinden atanmış özel (dinamik) item'ları da topla
      const effectiveItems = await fetchEffectiveItems(device.id);
      if (effectiveItems.length > 0) {
        const snmpSingleItems = effectiveItems.filter((i) => i.collector_type === "snmp" && !i.is_table);
        const snmpTableItems = effectiveItems.filter((i) => i.collector_type === "snmp" && i.is_table);
        const otherItems = effectiveItems.filter((i) => i.collector_type !== "snmp");

        if (snmpSingleItems.length > 0) {
          await pollEffectiveItems(device, snmpSingleItems, new Date().toISOString());
        }
        for (const item of snmpTableItems) {
          await pollTableItem(device, item, new Date().toISOString());
        }

        // Dependent item'ları (master_item_id dolu olanlar) ayrı işle — bunlar kendi
        // ağ çağrısını yapmaz, master'ın yanıtından türetilir.
        const dependentItems = otherItems.filter((i: any) => i.master_item_id);
        const independentItems = otherItems.filter((i: any) => !i.master_item_id);

        // Aynı master_item_id'ye sahip dependent'ları grupla, master'ı tek seferde çek
        const dependentsByMaster = new Map<string, any[]>();
        for (const dep of dependentItems) {
          const key = (dep as any).master_item_id;
          if (!dependentsByMaster.has(key)) dependentsByMaster.set(key, []);
          dependentsByMaster.get(key)!.push(dep);
        }

        for (const [masterId, deps] of dependentsByMaster.entries()) {
          const masterItem = effectiveItems.find((i: any) => i.id === masterId);
          if (!masterItem) {
            console.log(`[Master-Item] Master item bulunamadı (id=${masterId}), bağımlı item'lar atlanıyor`);
            continue;
          }
          await pollMasterWithDependents(masterItem, deps, device, new Date().toISOString());
        }

        for (const item of independentItems) {
          await pollMultiProtocolItem(device, item, new Date().toISOString());
        }
      }

      consecutiveFailures.delete(device.id);
      const successes = (consecutiveSuccesses.get(device.id) || 0) + 1;
      consecutiveSuccesses.set(device.id, successes);
      if (successes >= SUCCESS_THRESHOLD) {
        await updateDeviceStatus(device.id, "active");
        await reportCollectorStatus(device.id, "active");
      }
    } else {
      consecutiveSuccesses.delete(device.id);
      const failures = (consecutiveFailures.get(device.id) || 0) + 1;
      consecutiveFailures.set(device.id, failures);

      if (failures >= FAILURE_THRESHOLD) {
        await updateDeviceStatus(device.id, "down");
        await reportCollectorStatus(device.id, "down", "SNMP yanıt vermiyor (timeout)");
        console.log(`[NPM] ${device.name} 'down' olarak işaretlendi (${failures} art arda başarısız deneme)`);
      }
    }
  }
}

const DiscoverSchema = z.object({
  ip_address: z.string().ip(),
  community: z.string().default("public"),
  port: z.number().optional()
});

async function startHttpServer() {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ status: "ok", service: "npm-service" }));

  app.post("/api/v1/discovery/device", async (request, reply) => {
    const parsed = DiscoverSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const { ip_address, community, port } = parsed.data;
    const result = await discoverDevice(ip_address, community, port);
    return result;
  });

  const ScanSchema = z.object({
    cidr: z.string().min(1),
    community: z.string().default("public")
  });

  app.post("/api/v1/discovery/scan", async (request, reply) => {
    const parsed = ScanSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    try {
      const jobId = randomUUID();
      const result = await startSubnetScan(parsed.data.cidr, parsed.data.community, jobId);
      return reply.status(202).send(result);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  app.get("/api/v1/discovery/scan/:jobId", async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = await getJob(jobId);
    if (!job) return reply.status(404).send({ error: "Tarama işi bulunamadı" });
    return job;
  });

  const httpPort = Number(process.env.HTTP_PORT) || 3100;
  await app.listen({ port: httpPort, host: "0.0.0.0" });
  console.log(`[NPM] Discovery HTTP API hazır: ${httpPort}`);
}

async function main() {
  await connectRedis();
  console.log("[NPM] Redis bağlantısı kuruldu, polling döngüsü başlıyor...");
  await startHttpServer();
  await pollAllDevices();
  setInterval(pollAllDevices, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[NPM] Başlatma hatası:", err);
  process.exit(1);
});
