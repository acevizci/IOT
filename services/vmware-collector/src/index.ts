import http from "http";
import { connectRedis, publishMetric } from "./redisClient.js";
import { fetchVMwareDevices, resolveVMwareCredentials, reportCollectorStatus, resolveAlertsByTag } from "./coreClient.js";
import type { VMwareDevice } from "./coreClient.js";
import { VSphereClient } from "./vsphereClient.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 120000;
const HTTP_PORT = Number(process.env.HTTP_PORT) || 3600;

// KAYBOLAN VM TESPİTİ: bir VM (silinmiş/taşınmış) art arda kaç turda hiç görünmezse
// "gerçekten kayboldu" sayılıp açık alarmları otomatik kapatılsın. Tek bir kaçırılmış
// API yanıtı yüzünden erken/yanlışlıkla kapatmayı önlemek için 1'den büyük tutuluyor.
// NOT: bu takip SADECE bellekte tutuluyor (kalıcı DB tablosu YOK) -- collector process'i
// yeniden başlarsa sayaçlar sıfırlanır (kabul edilebilir bir basitleştirme, v1 kapsamı).
const MISSING_THRESHOLD_TICKS = 3;
// device_id -> (instance_label -> art arda kaç turdur görünmedi)
const missingStreaks = new Map<string, Map<string, number>>();

let lastTickAt = Date.now();

function startHealthServer() {
  http.createServer((req, res) => {
    if (req.url === "/health") {
      const staleMs = Date.now() - lastTickAt;
      const healthy = staleMs < POLL_INTERVAL_MS * 3;
      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: healthy ? "ok" : "stale", service: "vmware-collector", last_tick_ms_ago: staleMs }));
    } else {
      res.writeHead(404);
      res.end();
    }
  }).listen(HTTP_PORT, () => console.log(`[VMware-Collector] Health check HTTP: ${HTTP_PORT}`));
}

// GÜVENLİK/DOĞRULUK NOTU: NODE_TLS_REJECT_UNAUTHORIZED process genelinde geçerli bir
// ayardır (undici'nin per-request bir "sertifika doğrulamayı atla" seçeneği fetch()
// API'sinde kolayca yok) -- bu yüzden SADECE tls_skip_verify=true olan bir cihaza
// bağlanılırken GEÇICI olarak kapatılıp, o cihazın işlemi biter bitmez HEMEN geri
// açılıyor. Cihazlar arasında hiç PARALELLİK OLMAMASI (bkz. aşağıdaki for-of döngüsü,
// Promise.all DEĞİL) bilerek yapıldı -- aksi halde, aynı anda hem tls_skip_verify=true
// hem tls_skip_verify=false iki cihaza bağlanılırken bir yarış durumu (race condition)
// oluşup YANLIŞ cihaza YANLIŞ TLS ayarıyla bağlanma riski doğardı. Bu, birden çok
// vCenter'ı SIRAYLA işlemenin (paralel değil) bilinçli bir güvenlik/doğruluk tercihi
// olduğu anlamına gelir -- büyük ölçekte (§7 kardinalite testi) bunun kabul edilebilir
// performans etkisi olup olmadığı ayrıca değerlendirilmeli.
// KAYBOLAN VM TESPİTİ: bu turda görülen VM adlarını, önceki turlarda görülenlerle
// karşılaştırır. Bir VM art arda MISSING_THRESHOLD_TICKS turdur listede yoksa,
// "gerçekten kayboldu" sayılıp ona ait TÜM açık alarmlar toplu kapatılır.
async function checkForMissingVMs(deviceId: string, currentVmNames: string[]) {
  const currentSet = new Set(currentVmNames);
  const streaks = missingStreaks.get(deviceId) || new Map<string, number>();

  // Önceki turlarda takip edilen ama bu turda hâlâ görünmeyen VM'lerin sayacını artır.
  for (const [vmName, count] of streaks) {
    if (!currentSet.has(vmName)) {
      const newCount = count + 1;
      if (newCount >= MISSING_THRESHOLD_TICKS) {
        const resolvedCount = await resolveAlertsByTag(deviceId, vmName);
        console.log(`[VMware-Collector] VM '${vmName}' ${MISSING_THRESHOLD_TICKS} turdur görünmüyor -- kayıp sayıldı, ${resolvedCount} alarm kapatıldı`);
        streaks.delete(vmName); // artık takip etmeye gerek yok
      } else {
        streaks.set(vmName, newCount);
      }
    } else {
      streaks.delete(vmName); // tekrar göründü, sayaç sıfırlanır
    }
  }

  // Bu turda görülen ama daha önce hiç takip edilmeyen VM'ler için sayaç başlat (0'dan).
  for (const vmName of currentVmNames) {
    if (!streaks.has(vmName)) streaks.set(vmName, 0);
  }

  missingStreaks.set(deviceId, streaks);
}

async function withTlsSkipVerify<T>(skipVerify: boolean, fn: () => Promise<T>): Promise<T> {
  if (!skipVerify) return fn();
  const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = original;
  }
}

async function pollDevice(device: VMwareDevice) {
  const credentials = await resolveVMwareCredentials(device.id);
  if (!credentials) {
    const msg = "Kimlik bilgisi eksik — {$VMWARE_USER}/{$VMWARE_PASSWORD} bu cihaz için ayarlanmamış";
    console.log(`[VMware-Collector] ${device.name}: ${msg}`);
    await reportCollectorStatus(device.id, "down", msg);
    return;
  }

  const client = new VSphereClient({
    host: device.ip_address,
    port: device.port || 443,
    username: credentials.username,
    password: credentials.password,
    tlsSkipVerify: device.tls_skip_verify
  });

  try {
    await withTlsSkipVerify(device.tls_skip_verify, async () => {
      await client.login();

      const vms = await client.listVMs();
      const timestamp = new Date().toISOString();
      await checkForMissingVMs(device.id, vms.map((v) => v.name));

      // Envanter özeti (cihaz-seviyesi, instance_label YOK) -- tüm VM'lerin toplu durumu.
      const poweredOn = vms.filter((v) => v.power_state === "POWERED_ON").length;
      const poweredOff = vms.filter((v) => v.power_state === "POWERED_OFF").length;
      const suspended = vms.filter((v) => v.power_state === "SUSPENDED").length;
      await publishMetric({ event_type: "metric", source_module: "vmware", tenant_id: device.tenant_id, device_id: device.id, metric_name: "vmware_vm_count_total", timestamp, value: vms.length });
      await publishMetric({ event_type: "metric", source_module: "vmware", tenant_id: device.tenant_id, device_id: device.id, metric_name: "vmware_vm_count_powered_on", timestamp, value: poweredOn });
      await publishMetric({ event_type: "metric", source_module: "vmware", tenant_id: device.tenant_id, device_id: device.id, metric_name: "vmware_vm_count_powered_off", timestamp, value: poweredOff });
      await publishMetric({ event_type: "metric", source_module: "vmware", tenant_id: device.tenant_id, device_id: device.id, metric_name: "vmware_vm_count_suspended", timestamp, value: suspended });

      // VM-bazlı metrikler (instance_label = VM adı) -- Faz J.0'ın instance-farkında
      // alarm motoru bunu grup anahtarı olarak kullanabilir.
      for (const vm of vms) {
        const tags = { instance_label: vm.name };
        await publishMetric({ event_type: "metric", source_module: "vmware", tenant_id: device.tenant_id, device_id: device.id, metric_name: "vmware_vm_power_state", timestamp, value: vm.power_state === "POWERED_ON" ? 1 : 0, tags });
        await publishMetric({ event_type: "metric", source_module: "vmware", tenant_id: device.tenant_id, device_id: device.id, metric_name: "vmware_vm_cpu_count", timestamp, value: vm.cpu_count, tags });
        await publishMetric({ event_type: "metric", source_module: "vmware", tenant_id: device.tenant_id, device_id: device.id, metric_name: "vmware_vm_memory_size_mib", timestamp, value: vm.memory_size_MiB, tags });
      }

      // Datastore metrikleri (instance_label = datastore adı).
      const datastores = await client.listDatastores();
      for (const ds of datastores) {
        const tags = { instance_label: ds.name };
        const usedPercent = ds.capacity > 0 ? ((ds.capacity - ds.free_space) / ds.capacity) * 100 : 0;
        await publishMetric({ event_type: "metric", source_module: "vmware", tenant_id: device.tenant_id, device_id: device.id, metric_name: "vmware_datastore_used_percent", timestamp, value: usedPercent, unit: "%", tags });
        await publishMetric({ event_type: "metric", source_module: "vmware", tenant_id: device.tenant_id, device_id: device.id, metric_name: "vmware_datastore_free_bytes", timestamp, value: ds.free_space, unit: "bytes", tags });
      }

      // Cluster/host metrikleri SADECE vCenter modunda anlamlı (ESXi bağımsızda cluster
      // kavramı yok -- vsphereClient.ts'teki notu bkz.).
      if (device.vmware_mode === "vcenter") {
        const hosts = await client.listHosts();
        const connectedHosts = hosts.filter((h) => h.connection_state === "CONNECTED").length;
        await publishMetric({ event_type: "metric", source_module: "vmware", tenant_id: device.tenant_id, device_id: device.id, metric_name: "vmware_host_count_connected", timestamp, value: connectedHosts });

        const clusters = await client.listClusters();
        for (const cluster of clusters) {
          const tags = { instance_label: cluster.name };
          await publishMetric({ event_type: "metric", source_module: "vmware", tenant_id: device.tenant_id, device_id: device.id, metric_name: "vmware_cluster_drs_enabled", timestamp, value: cluster.drs_enabled ? 1 : 0, tags });
          await publishMetric({ event_type: "metric", source_module: "vmware", tenant_id: device.tenant_id, device_id: device.id, metric_name: "vmware_cluster_ha_enabled", timestamp, value: cluster.ha_enabled ? 1 : 0, tags });
        }
      }

      await client.logout();
    });

    console.log(`[VMware-Collector] ${device.name} (${device.vmware_mode}): tarama tamamlandı`);
    await reportCollectorStatus(device.id, "active");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[VMware-Collector] ${device.name}: hata - ${msg}`);
    await reportCollectorStatus(device.id, "down", msg);
  }
}

async function pollAllDevices() {
  lastTickAt = Date.now();
  const devices = await fetchVMwareDevices();
  console.log(`[VMware-Collector] ${devices.length} VMware cihazı polling ediliyor...`);

  // BİLİNÇLİ OLARAK SIRALI (Promise.all DEĞİL) -- bkz. withTlsSkipVerify() üzerindeki
  // yarış durumu notu.
  for (const device of devices) {
    await pollDevice(device);
  }
}

// GÜVENİLİRLİK: diğer collector'larda bulunup düzeltilen aynı sınıf hata -- setInterval
// ile çağrılan fonksiyon hata fırlatırsa önceden tüm process çöküyordu.
function safeRun(fn: () => Promise<void>, label: string): () => void {
  return () => {
    fn().catch((err) => {
      console.error(`[VMware-Collector] ${label} sırasında yakalanmamış hata (bir sonraki tur devam edecek):`, err);
    });
  };
}

async function main() {
  await connectRedis();
  console.log("[VMware-Collector] Redis bağlantısı kuruldu, polling döngüsü başlıyor...");
  startHealthServer();
  const safePollAllDevices = safeRun(pollAllDevices, "pollAllDevices");
  safePollAllDevices();
  setInterval(safePollAllDevices, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[VMware-Collector] Başlatma hatası:", err);
  process.exit(1);
});
