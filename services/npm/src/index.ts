import { getActiveDevices } from "./db.js";
import { connectRedis } from "./redisClient.js";
import { pollDevice } from "./snmpPoller.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 60000;

async function pollAllDevices() {
  const devices = await getActiveDevices();
  console.log(`[NPM] ${devices.length} cihaz polling ediliyor...`);

  for (const device of devices) {
    await pollDevice(device);
  }
}

async function main() {
  await connectRedis();
  console.log("[NPM] Redis bağlantısı kuruldu, polling döngüsü başlıyor...");

  // İlk çalıştırma hemen, sonrası aralıklı
  await pollAllDevices();
  setInterval(pollAllDevices, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[NPM] Başlatma hatası:", err);
  process.exit(1);
});
