import { getActiveDevices, updateDeviceStatus } from "./db.js";
import { connectRedis } from "./redisClient.js";
import { pollDevice } from "./snmpPoller.js";

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

async function main() {
  await connectRedis();
  console.log("[NPM] Redis bağlantısı kuruldu, polling döngüsü başlıyor...");
  await pollAllDevices();
  setInterval(pollAllDevices, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[NPM] Başlatma hatası:", err);
  process.exit(1);
});
