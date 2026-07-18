#!/usr/bin/env node
// FAZ J Adım 3 — Kardinalite yük testi.
//
// VMware collector'ı henüz yazılmadığı için, gerçek trafiğini Redis Stream'e
// (metrics.raw) DOĞRUDAN, publishAgentMetric()'in ürettiği ile AYNI şekilde
// senkron/eşzamanlı simüle ediyoruz. Bu, metrics-consumer'ın gerçek yazma hızı
// altında davranışını, TimescaleDB'nin büyüme oranını ve genel sistem
// stabilitesini, gerçek collector kodu yazılmadan ÖNCE ölçmemizi sağlıyor.
//
// Kullanım (arka planda, terminal kapansa bile devam etsin diye nohup ile):
//   docker cp loadtest_vmware.js obs-metrics-consumer:/app/loadtest_vmware.js
//   docker compose exec -d metrics-consumer node /app/loadtest_vmware.js \
//     --device-id=<GERCEK_DEVICE_ID> --tenant-id=<GERCEK_TENANT_ID> \
//     --vms=300 --metrics-per-vm=8 --interval-sec=120 --duration-min=180
//
// Varsayılanlar tasarım dokümanının kendi sayılarıyla (300 VM, 8 metrik, 120sn) eşleşir.

const { createClient } = require("redis");

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    args[key] = value;
  }
  return {
    deviceId: args["device-id"],
    tenantId: args["tenant-id"],
    vmCount: Number(args["vms"] || 300),
    metricsPerVm: Number(args["metrics-per-vm"] || 8),
    intervalSec: Number(args["interval-sec"] || 120),
    durationMin: Number(args["duration-min"] || 180)
  };
}

const METRIC_NAMES = [
  "vm_cpu_usage_percent", "vm_memory_usage_percent", "vm_memory_active_bytes",
  "vm_disk_read_iops", "vm_disk_write_iops", "vm_network_rx_bytes",
  "vm_network_tx_bytes", "vm_uptime_seconds"
];

async function main() {
  const { deviceId, tenantId, vmCount, metricsPerVm, intervalSec, durationMin } = parseArgs();
  if (!deviceId || !tenantId) {
    console.error("KULLANIM: node loadtest_vmware.js --device-id=<uuid> --tenant-id=<uuid> [--vms=300] [--metrics-per-vm=8] [--interval-sec=120] [--duration-min=180]");
    process.exit(1);
  }

  const totalSeries = vmCount * metricsPerVm;
  const eventsPerSecond = totalSeries / intervalSec;
  console.log(`[LoadTest] ${vmCount} VM x ${metricsPerVm} metrik = ${totalSeries} seri, ${intervalSec}sn aralıkla`);
  console.log(`[LoadTest] Hedef sürekli hız: ~${eventsPerSecond.toFixed(1)} olay/sn, ${durationMin} dakika boyunca`);
  console.log(`[LoadTest] Günlük tahmini satır: ${Math.round(totalSeries * (86400 / intervalSec)).toLocaleString("tr-TR")}`);

  const client = createClient({ url: process.env.REDIS_URL || "redis://redis:6379" });
  client.on("error", (err) => console.error("[LoadTest] Redis hatası:", err));
  await client.connect();

  const endAt = Date.now() + durationMin * 60 * 1000;
  let totalPublished = 0;
  let tickCount = 0;
  const startedAt = Date.now();

  // METRİK NAMESPACE UYARISI: gerçek alarm kurallarını/dashboard'ları etkilememesi
  // için tüm metrik isimleri 'loadtest_' önekiyle -- test bitince aşağıdaki temizlik
  // komutuyla kolayca silinebilir.
  async function tick() {
    const timestamp = new Date().toISOString();
    const promises = [];
    for (let vmIndex = 0; vmIndex < vmCount; vmIndex++) {
      const instanceLabel = `vm-${String(vmIndex).padStart(4, "0")}`;
      for (let m = 0; m < metricsPerVm; m++) {
        const event = {
          event_type: "metric",
          source_module: "vmware-loadtest",
          tenant_id: tenantId,
          device_id: deviceId,
          metric_name: `loadtest_${METRIC_NAMES[m % METRIC_NAMES.length]}`,
          timestamp,
          value: Math.random() * 100,
          tags: { instance_label: instanceLabel }
        };
        promises.push(
          client.xAdd("metrics.raw", "*", { data: JSON.stringify(event) }, { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 100000 } })
        );
      }
    }
    await Promise.all(promises);
    totalPublished += promises.length;
    tickCount++;
    const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(`[LoadTest] Tur ${tickCount}: ${promises.length} olay yayınlandı (toplam: ${totalPublished.toLocaleString("tr-TR")}, geçen süre: ${elapsedMin}dk)`);
  }

  while (Date.now() < endAt) {
    const tickStart = Date.now();
    await tick();
    const tickDuration = Date.now() - tickStart;
    const waitMs = Math.max(intervalSec * 1000 - tickDuration, 0);
    if (tickDuration > intervalSec * 1000) {
      console.warn(`[LoadTest] UYARI: bir tur yayınlaması (${tickDuration}ms) hedef aralıktan (${intervalSec * 1000}ms) UZUN SÜRDÜ -- Redis/ağ darboğazı olabilir.`);
    }
    await new Promise((r) => setTimeout(r, waitMs));
  }

  console.log(`[LoadTest] Tamamlandı. Toplam ${totalPublished.toLocaleString("tr-TR")} olay, ${tickCount} tur, ${durationMin} dakikada.`);
  await client.quit();
}

main().catch((err) => {
  console.error("[LoadTest] Hata:", err);
  process.exit(1);
});
