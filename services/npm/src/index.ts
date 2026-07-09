import { getActiveDevices, updateDeviceStatus } from "./db.js";
import { connectRedis } from "./redisClient.js";
import { pollDevice, pollEffectiveItems, pollTableItem } from "./snmpPoller.js";
import { fetchEffectiveItems } from "./effectiveItems.js";
import { pollMultiProtocolItem } from "./multiProtocolCollectors.js";
import Fastify from "fastify";
import { z } from "zod";
import { discoverDevice } from "./discovery.js";
import { startSubnetScan, getJob } from "./subnetScan.js";
import { randomUUID } from "crypto";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 60000;
const FAILURE_THRESHOLD = Number(process.env.FAILURE_THRESHOLD) || 2;

// Cihaz bazlı art arda başarısızlık sayacı (flapping'i önlemek için — madde: alarm motorunda çözdüğümüz aynı problem)
const consecutiveFailures = new Map<string, number>();

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
        for (const item of otherItems) {
          await pollMultiProtocolItem(device, item, new Date().toISOString());
        }
      }

      if (consecutiveFailures.get(device.id)) {
        consecutiveFailures.delete(device.id);
      }
      await updateDeviceStatus(device.id, "active");
    } else {
      const failures = (consecutiveFailures.get(device.id) || 0) + 1;
      consecutiveFailures.set(device.id, failures);

      if (failures >= FAILURE_THRESHOLD) {
        await updateDeviceStatus(device.id, "down");
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
