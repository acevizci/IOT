import { connectRedis } from "./redisClient.js";
import { fetchAllDeviceIds, fetchEffectiveItems } from "./coreClient.js";
import { pollSshItem } from "./sshPoller.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 60000;

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

async function main() {
  await connectRedis();
  console.log("[Exec-Collector] Redis bağlantısı kuruldu, polling döngüsü başlıyor...");
  await pollAllSshItems();
  setInterval(pollAllSshItems, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[Exec-Collector] Başlatma hatası:", err);
  process.exit(1);
});
