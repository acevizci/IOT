import Fastify from "fastify";
import { connectRedis } from "./redisClient.js";
import { fetchAllDeviceIds, fetchEffectiveItems, fetchResolvedConfig } from "./coreClient.js";
import { pollSshItem, runSshCommand } from "./sshPoller.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 60000;
const HTTP_PORT = Number(process.env.HTTP_PORT) || 3200;

async function pollAllSshItems() {
  const devices = await fetchAllDeviceIds();
  let itemCount = 0;
  for (const device of devices) {
    const items = await fetchEffectiveItems(device.id);
    const sshItems = items.filter((i) => i.collector_type === "ssh_exec");
    for (const item of sshItems) {
      await pollSshItem(device, item, new Date().toISOString());
      itemCount++;
    }
  }
  if (itemCount > 0) {
    console.log(`[Exec-Collector] ${itemCount} SSH item polling edildi`);
  }
}

// Alarm Engine'in eskalasyon adımı olarak (trigger'a bağlı) ad-hoc uzak komut
// çalıştırabilmesi için basit bir HTTP endpoint — cihazın kendi SSH ayarını (makro
// üzerinden) çözüp, verilen komutu bir kez çalıştırır. Sonucu loglar, metrik üretmez
// (poll döngüsündeki normal SSH item'lardan farklı olarak tek seferlik bir aksiyon).
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET || "";

async function startHttpServer() {
  const app = Fastify();

  app.post("/trigger-command", async (request, reply) => {
    const internalSecret = request.headers["x-internal-secret"];
    if (!internalSecret || internalSecret !== INTERNAL_SECRET) {
      return reply.status(403).send({ error: "Bu endpoint sadece internal servisler icindir" });
    }

    const { device_id, command } = request.body as { device_id: string; command: string };
    if (!device_id || !command) return reply.status(400).send({ error: "device_id ve command gerekli" });

    const devices = await fetchAllDeviceIds();
    const device = devices.find((d) => d.id === device_id);
    if (!device) return reply.status(404).send({ error: "Cihaz bulunamadı" });

    // Aynı standart makro referanslarını (SSH item'ların kullandığı) çözerek bu cihazın
    // SSH kimlik bilgisini alıyoruz — ayrı bir mekanizma icat etmiyoruz.
    const resolved = await fetchResolvedConfig(device_id, {
      port: "{$SSH_PORT}", username: "{$SSH_USER}", password: "{$SSH_PASSWORD}", auth_type: "password"
    });
    if (!resolved?.username || !resolved?.password) {
      console.log(`[Escalation-Command] ${device.name}: SSH bağlantı bilgisi eksik`);
      return reply.status(422).send({ error: "Cihaz için SSH ayarı (makro) tanımlanmamış" });
    }

    try {
      const output = await runSshCommand(
        device.ip_address, Number(resolved.port) || 22,
        resolved.username, "password", resolved.password, command
      );
      console.log(`[Escalation-Command] ${device.name}: "${command}" çalıştırıldı — çıktı: ${output.trim().slice(0, 200)}`);
      return { success: true, output: output.trim().slice(0, 1000) };
    } catch (err: any) {
      console.log(`[Escalation-Command] ${device.name}: komut hatası - ${err.message}`);
      return reply.status(500).send({ error: err.message });
    }
  });

  await app.listen({ host: "0.0.0.0", port: HTTP_PORT });
  console.log(`[Exec-Collector] HTTP API hazır: ${HTTP_PORT}`);
}

async function main() {
  await connectRedis();
  console.log("[Exec-Collector] Redis bağlantısı kuruldu, polling döngüsü başlıyor...");
  await startHttpServer();
  await pollAllSshItems();
  setInterval(pollAllSshItems, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[Exec-Collector] Başlatma hatası:", err);
  process.exit(1);
});
