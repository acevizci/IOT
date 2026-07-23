import snmp from "net-snmp";
import { evaluate } from "mathjs";
import { applyPreprocessing } from "./preprocessing.js";
import type { DeviceRow } from "./db.js";
import { publishMetric } from "./redisClient.js";

const OIDS = {
  sysUpTime: "1.3.6.1.2.1.1.3.0",
  ifTable: "1.3.6.1.2.1.2.2",
  // GERÇEK EKSİKLİK DÜZELTMESİ (endüstri standardı, RAM/disk/CPU/ethernet
  // incelemesinde bulundu): SNMP ile izlenen (agent'sız) bir cihazda disk
  // bilgisi HİÇ yoktu -- HOST-RESOURCES-MIB'in hrStorageTable'ı hiç
  // sorgulanmıyordu. Zabbix/LibreNMS'in "Generic SNMP"/"Linux SNMP"
  // şablonlarının hepsi bunu temel alır.
  hrStorageTable: "1.3.6.1.2.1.25.2.3",
  // GERÇEK EKSİKLİK DÜZELTMESİ (endüstri standardı): klasik ifTable'daki
  // ifInOctets/ifOutOctets 32-bit sayaçlar -- gigabit+ bir bağlantıda birkaç
  // dakika içinde sarılabilir (2^32 byte ~4.3GB). LibreNMS/Zabbix/PRTG gibi
  // araçların hepsi cihaz destekliyorsa ifXTable'ın 64-bit "HC" (High Capacity)
  // sayaçlarını (ifHCInOctets/ifHCOutOctets) TERCİH EDER, sadece eski/basit
  // cihazlarda 32-bit'e düşer. Aynı desen burada da uygulanıyor.
  ifXTable: "1.3.6.1.2.1.31.1.1",
  laLoad1min: "1.3.6.1.4.1.2021.10.1.3.1",
  memAvailReal: "1.3.6.1.4.1.2021.4.6.0",
  memTotalReal: "1.3.6.1.4.1.2021.4.5.0"
};

const IF_COLUMNS = {
  ifDescr: 2,
  ifOperStatus: 8,
  ifInOctets: 10,
  // GERÇEK EKSİKLİK DÜZELTMESİ (endüstri standardı): sadece trafik hacmi
  // (octets) izleniyordu -- ağ SAĞLIĞI için standart olan hata/düşme
  // sayaçları (Zabbix'in net.if.in/out[,errors]/[,discards] item'ları) hiç
  // toplanmıyordu. Bir arayüzde paket kaybı/hata varsa bunu görmenin tek yolu
  // önceden manuel SNMP sorgusuydu.
  ifInDiscards: 13,
  ifInErrors: 14,
  ifOutOctets: 16,
  ifOutDiscards: 19,
  ifOutErrors: 20
};

// HOST-RESOURCES-MIB hrStorageEntry sütunları.
const HR_STORAGE_COLUMNS = {
  hrStorageType: 2,
  hrStorageDescr: 3,
  hrStorageAllocationUnits: 4,
  hrStorageSize: 5,
  hrStorageUsed: 6
};

// hrStorageType OID'leri -- hrStorageRam/VirtualMemory gibi bellek girdileri
// AYNI tabloda görünür (özellikle Linux'ta Net-SNMP "Physical memory"/"Swap
// space"/"Virtual memory" satırları da ekler) -- SADECE gerçek disk
// bölümlerini (sabit + ağ diskleri) almak için filtreleniyor.
const HR_STORAGE_FIXED_DISK = "1.3.6.1.2.1.25.2.1.4";
const HR_STORAGE_NETWORK_DISK = "1.3.6.1.2.1.25.2.1.10";

// ifXTable sütun indeksleri (IF-MIB'in genişletilmiş tablosu) -- ifHCInOctets/
// ifHCOutOctets 64-bit COUNTER64, sarılması pratikte hiç gerçekleşmez.
const IFX_COLUMNS = {
  ifHCInOctets: 6,
  ifHCOutOctets: 10
};

const COUNTER32_MAX = 4294967295; // 2^32 - 1

// GERÇEK EKSİKLİK DÜZELTMESİ (endüstri standardı): if_in_octets/if_out_octets
// HAM, sürekli artan sayaçlardı -- platformda bunları "şu an ne kadar trafik
// var" (byte/sn) değerine çeviren HİÇBİR hesaplama yoktu. Zabbix/LibreNMS/
// Cacti'nin hepsi ham sayacı SAKLAR ama grafiklerinde/eşiklerinde iki örnek
// arasındaki DELTA'yı (sarılmaya karşı korumalı) kullanır. Süreç ömrü boyunca
// kalıcı bir bellek-içi önbellek (npm-service tek, uzun ömürlü bir process,
// periyodik olarak AYNI cihaz/interface'i polluyor) yeterli -- veritabanına
// gidip-gelmeye gerek yok.
interface CounterSample { value: number; timestampMs: number; is32Bit: boolean }
const interfaceCounterCache = new Map<string, CounterSample>();

// prevValue -> currentValue arası byte/saniye hesaplar. Sayaç sıfırlanmışsa
// (cihaz yeniden başlamış) ya da 32-bit sayaç sarılmışsa (delta negatif çıkar)
// sarılmaya göre düzeltir. 64-bit sayaçta negatif delta pratikte SIFIRLANMA
// anlamına gelir (2^64 sarılması yüzyıllar sürer) -- o durumda hesaplanmaz.
function computeInterfaceRate(key: string, value: number, timestampMs: number, is32Bit: boolean): number | null {
  const prev = interfaceCounterCache.get(key);
  interfaceCounterCache.set(key, { value, timestampMs, is32Bit });
  if (!prev || prev.is32Bit !== is32Bit) return null; // ilk örnek ya da sayaç genişliği değişti (HC'ye yeni geçildi) -- karşılaştırılamaz

  const dtSeconds = (timestampMs - prev.timestampMs) / 1000;
  if (dtSeconds <= 0) return null;

  let delta = value - prev.value;
  if (delta < 0) {
    if (!is32Bit) return null; // 64-bit'te negatif delta = sayaç sıfırlanması, hesaplanamaz
    delta = COUNTER32_MAX - prev.value + value + 1;
  }
  return delta / dtSeconds;
}

function createSession(device: DeviceRow) {
  const community = device.snmp_config?.community || "public";
  const port = device.snmp_config?.port || 161;
  return snmp.createSession(device.ip_address, community, {
    port,
    timeout: 5000,
    retries: 1,
    version: snmp.Version2c
  });
}

// Dönüş değeri: cihazın canlı/erişilebilir olup olmadığı (health check sonucu)
async function pollSysUpTime(session: any, device: DeviceRow, timestamp: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    session.get([OIDS.sysUpTime], async (error: any, varbinds: any[]) => {
      if (error) {
        console.error(`[SNMP] ${device.name} sysUpTime hata:`, error.message);
        return resolve(false);
      }
      const vb = varbinds[0];
      if (!snmp.isVarbindError(vb)) {
        const uptimeSeconds = Number(vb.value) / 100;
        await publishMetric({
          event_type: "metric",
          source_module: "npm",
          tenant_id: device.tenant_id,
          device_id: device.id,
          metric_name: "sys_uptime_seconds",
          timestamp,
          value: uptimeSeconds,
          unit: "seconds"
        });
        return resolve(true);
      }
      resolve(false);
    });
  });
}

// ifXTable'ı ayrı bir tablo yürüyüşüyle çeker -- eski/basit cihazlar bu OID'i
// hiç desteklemeyebilir (hata döner), bu durumda sessizce boş harita dönülür,
// çağıran taraf 32-bit'e düşer (GERÇEK bir hata değil, beklenen bir durum).
async function fetchIfXTable(session: any): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    session.table(OIDS.ifXTable, 20, (error: any, table: any) => {
      resolve(error ? {} : table);
    });
  });
}

async function pollInterfaces(session: any, device: DeviceRow, timestamp: string) {
  const timestampMs = new Date(timestamp).getTime();
  const ifXTable = await fetchIfXTable(session);

  return new Promise<void>((resolve) => {
    session.table(OIDS.ifTable, 20, async (error: any, table: any) => {
      if (error) {
        console.error(`[SNMP] ${device.name} ifTable hata:`, error.message);
        return resolve();
      }
      for (const ifIndex of Object.keys(table)) {
        const row = table[ifIndex];
        const ifDescr = row[IF_COLUMNS.ifDescr]?.toString() || `if${ifIndex}`;
        const operStatus = Number(row[IF_COLUMNS.ifOperStatus]);

        // 64-bit HC sayaç varsa (ifXTable bu ifIndex için döndüyse ve sıfır
        // değilse -- bazı cihazlar HC sütunlarını destekler ama hep 0 doldurur)
        // onu tercih et, yoksa 32-bit'e düş.
        const ifxRow = ifXTable[ifIndex];
        const hcIn = ifxRow ? Number(ifxRow[IFX_COLUMNS.ifHCInOctets]) : NaN;
        const hcOut = ifxRow ? Number(ifxRow[IFX_COLUMNS.ifHCOutOctets]) : NaN;
        const use64Bit = !Number.isNaN(hcIn) && !Number.isNaN(hcOut) && (hcIn > 0 || hcOut > 0);
        const inOctets = use64Bit ? hcIn : Number(row[IF_COLUMNS.ifInOctets]);
        const outOctets = use64Bit ? hcOut : Number(row[IF_COLUMNS.ifOutOctets]);

        await publishMetric({
          event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
          metric_name: "if_oper_status", timestamp, value: operStatus, unit: "status", tags: { interface: ifDescr }
        });
        if (!Number.isNaN(inOctets)) {
          await publishMetric({
            event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
            metric_name: "if_in_octets", timestamp, value: inOctets, unit: "bytes", tags: { interface: ifDescr }
          });
          // GERÇEK EKSİKLİK DÜZELTMESİ: ham sayaçtan, sarılmaya karşı korumalı
          // byte/saniye hızı -- "şu an ne kadar trafik var" sorusuna artık
          // gerçekten cevap veren bir metrik (bkz. computeInterfaceRate).
          const inRate = computeInterfaceRate(`${device.id}:${ifDescr}:in`, inOctets, timestampMs, !use64Bit);
          if (inRate !== null) {
            await publishMetric({
              event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
              metric_name: "if_in_bps", timestamp, value: Math.round(inRate * 100) / 100, unit: "Bps", tags: { interface: ifDescr }
            });
          }
        }
        if (!Number.isNaN(outOctets)) {
          await publishMetric({
            event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
            metric_name: "if_out_octets", timestamp, value: outOctets, unit: "bytes", tags: { interface: ifDescr }
          });
          const outRate = computeInterfaceRate(`${device.id}:${ifDescr}:out`, outOctets, timestampMs, !use64Bit);
          if (outRate !== null) {
            await publishMetric({
              event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
              metric_name: "if_out_bps", timestamp, value: Math.round(outRate * 100) / 100, unit: "Bps", tags: { interface: ifDescr }
            });
          }
        }

        const inErrors = Number(row[IF_COLUMNS.ifInErrors]);
        const outErrors = Number(row[IF_COLUMNS.ifOutErrors]);
        const inDiscards = Number(row[IF_COLUMNS.ifInDiscards]);
        const outDiscards = Number(row[IF_COLUMNS.ifOutDiscards]);
        if (!Number.isNaN(inErrors)) {
          await publishMetric({
            event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
            metric_name: "if_in_errors", timestamp, value: inErrors, unit: "count", tags: { interface: ifDescr }
          });
        }
        if (!Number.isNaN(outErrors)) {
          await publishMetric({
            event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
            metric_name: "if_out_errors", timestamp, value: outErrors, unit: "count", tags: { interface: ifDescr }
          });
        }
        if (!Number.isNaN(inDiscards)) {
          await publishMetric({
            event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
            metric_name: "if_in_discards", timestamp, value: inDiscards, unit: "count", tags: { interface: ifDescr }
          });
        }
        if (!Number.isNaN(outDiscards)) {
          await publishMetric({
            event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
            metric_name: "if_out_discards", timestamp, value: outDiscards, unit: "count", tags: { interface: ifDescr }
          });
        }
      }
      resolve();
    });
  });
}

// GERÇEK EKSİKLİK DÜZELTMESİ (endüstri standardı): SNMP ile izlenen (agent'sız)
// bir cihazda disk bilgisi HİÇ yoktu. HOST-RESOURCES-MIB'in hrStorageTable'ı
// hem sabit diskleri hem RAM/sanal bellek gibi "depolama" girdilerini AYNI
// tabloda listeler -- SADECE gerçek disk bölümlerini (FixedDisk/NetworkDisk)
// almak için hrStorageType'a göre filtreleniyor. Metrik adı BİLEREK agent'ın
// disk_used_percent'iyle AYNI -- böylece mevcut widget'lar/kurallar hangi
// yöntemle izlendiğinden BAĞIMSIZ çalışır.
async function pollDiskStorage(session: any, device: DeviceRow, timestamp: string): Promise<void> {
  return new Promise<void>((resolve) => {
    session.table(OIDS.hrStorageTable, 20, async (error: any, table: any) => {
      // HOST-RESOURCES-MIB her SNMP ajanında bulunmaz (örn. bazı switch/router
      // firmware'leri sadece IF-MIB/temel MIB-II destekler) -- bu BEKLENEN bir
      // durumdur, hata olarak loglanmaz.
      if (error) return resolve();

      for (const idx of Object.keys(table)) {
        const row = table[idx];
        const storageType = row[HR_STORAGE_COLUMNS.hrStorageType]?.toString() || "";
        if (storageType !== HR_STORAGE_FIXED_DISK && storageType !== HR_STORAGE_NETWORK_DISK) continue;

        const descr = row[HR_STORAGE_COLUMNS.hrStorageDescr]?.toString() || `disk${idx}`;
        const allocUnits = Number(row[HR_STORAGE_COLUMNS.hrStorageAllocationUnits]);
        const size = Number(row[HR_STORAGE_COLUMNS.hrStorageSize]);
        const used = Number(row[HR_STORAGE_COLUMNS.hrStorageUsed]);
        if (!allocUnits || !size) continue; // sıfıra bölme / eksik veri -- sessizce atla

        const usedPercent = (used / size) * 100;
        await publishMetric({
          event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
          metric_name: "disk_used_percent", timestamp, value: Math.round(usedPercent * 100) / 100, unit: "%", tags: { interface: descr }
        });
      }
      resolve();
    });
  });
}

async function pollCpuMemory(session: any, device: DeviceRow, timestamp: string) {
  return new Promise<void>((resolve) => {
    session.get([OIDS.laLoad1min, OIDS.memAvailReal, OIDS.memTotalReal], async (error: any, varbinds: any[]) => {
      if (error) return resolve();
      const [loadVb, memAvailVb, memTotalVb] = varbinds;

      if (!snmp.isVarbindError(loadVb)) {
        const load = parseFloat(loadVb.value.toString());
        if (!Number.isNaN(load)) {
          await publishMetric({
            event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
            metric_name: "cpu_load_1min", timestamp, value: load, unit: "load"
          });
        }
      }
      if (!snmp.isVarbindError(memAvailVb) && !snmp.isVarbindError(memTotalVb)) {
        const memAvail = Number(memAvailVb.value);
        const memTotal = Number(memTotalVb.value);
        if (memTotal > 0) {
          const usedPercent = ((memTotal - memAvail) / memTotal) * 100;
          await publishMetric({
            event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
            metric_name: "memory_used_percent", timestamp, value: Number(usedPercent.toFixed(2)), unit: "percent"
          });
        }
      }
      resolve();
    });
  });
}

// Dönüş değeri: health check başarılı mı (durum otomasyonu için kullanılacak)
export async function pollDevice(device: DeviceRow): Promise<boolean> {
  const session = createSession(device);
  const timestamp = new Date().toISOString();

  try {
    const isHealthy = await pollSysUpTime(session, device, timestamp);
    if (isHealthy) {
      await pollInterfaces(session, device, timestamp);
      await pollCpuMemory(session, device, timestamp);
      await pollDiskStorage(session, device, timestamp);
    }
    return isHealthy;
  } finally {
    session.close();
  }
}

// ============ DİNAMİK ITEM POLLING (template bazlı, kod içinde sabit OID yok) ============
import type { EffectiveItem } from "./effectiveItems.js";


// Formül tabanlı türetilmiş metrik: birden fazla OID'i tek seferde çekip,
// tanımlı matematiksel ifadeyi (örn. "(used-free)/used*100") güvenli şekilde hesaplar.
// mathjs.evaluate() eval() değil, sınırlı bir matematik ifade motoru kullanır — güvenli.
async function pollFormulaItem(session: any, device: DeviceRow, item: any, timestamp: string): Promise<void> {
  const varNames = Object.keys(item.formula_oids);
  const oids = varNames.map((name) => item.formula_oids[name]);

  await new Promise<void>((resolve) => {
    session.get(oids, async (error: any, varbinds: any[]) => {
      if (error) {
        console.log(`[SNMP-Formula] ${device.name} ${item.metric_name} hata: ${error.message}`);
        return resolve();
      }

      const scope: Record<string, number> = {};
      let hasError = false;
      for (let i = 0; i < varbinds.length; i++) {
        const vb = varbinds[i];
        if (snmp.isVarbindError(vb)) {
          hasError = true;
          break;
        }
        scope[varNames[i]] = Number(vb.value);
      }

      if (hasError) {
        console.log(`[SNMP-Formula] ${device.name} ${item.metric_name}: bir veya daha fazla OID okunamadı`);
        return resolve();
      }

      try {
        const result = evaluate(item.formula, scope);
        const value = Number(result);
        if (Number.isNaN(value)) {
          console.log(`[SNMP-Formula] ${device.name} ${item.metric_name}: formül sonucu sayı değil`);
          return resolve();
        }

        await publishMetric({
          event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
          metric_name: item.metric_name, timestamp, value: Number(value.toFixed(2)), unit: item.unit || undefined
        });
        console.log(`[SNMP-Formula] ${device.name}: ${item.metric_name} = ${value.toFixed(2)} (formül: ${item.formula})`);
      } catch (err: any) {
        console.log(`[SNMP-Formula] ${device.name} ${item.metric_name} formül hatası: ${err.message}`);
      }
      resolve();
    });
  });
}

// Faz Queue-audit: session-level bir hata (varsa) donduruluyor.
export async function pollEffectiveItems(
  device: DeviceRow,
  items: EffectiveItem[],
  timestamp: string
): Promise<string | undefined> {
  if (items.length === 0) return undefined;

  const session = createSession(device);

  // Formül tabanlı (türetilmiş) metrikleri ayrı işle — bunlar birden fazla OID gerektirir.
  const formulaItems = items.filter((i) => i.formula && i.formula_oids);
  for (const item of formulaItems) {
    await pollFormulaItem(session, device, item, timestamp);
  }

  const singleOidItems = items.filter((i) => !i.is_table && !i.formula && i.oid);
  if (singleOidItems.length === 0) {
    session.close();
    return undefined;
  }

  // Session seviyesinde beklenmedik hataları yakala (aksi halde unhandled 'error'
  // event'i callback'i hiç tetiklemeden sessizce asılı kalmaya sebep olabilir).
  session.on("error", (err: any) => {
    console.log(`[SNMP] ${device.name} custom item session hatası: ${err?.message || err}`);
  });

  const oids = singleOidItems.map((i) => i.oid);
  console.log(`[SNMP-Custom] ${device.name}: ${oids.length} özel OID sorgulanıyor...`);

  let settled = false;
  let sessionError: string | undefined;

  const getPromise = new Promise<void>((resolve) => {
    try {
      session.get(oids, async (error: any, varbinds: any[]) => {
        if (settled) return;
        if (error) {
          console.log(`[SNMP] ${device.name} custom item hata: ${error.message}`);
          sessionError = error.message;
          settled = true;
          return resolve();
        }
        for (let i = 0; i < varbinds.length; i++) {
          const vb = varbinds[i];
          const item = singleOidItems[i];
          if (snmp.isVarbindError(vb)) {
            console.log(`[SNMP-Custom] ${device.name}: ${item.metric_name} varbind hatası`);
            continue;
          }

          const rawValue = vb.value;
          const parsedValue = item.data_type === "string" ? null : parseFloat(rawValue.toString());
          if (parsedValue === null || Number.isNaN(parsedValue)) continue;

          const steps = item.preprocessing || [];
          const finalValue = steps.length > 0
            ? await applyPreprocessing(device.id, item.metric_name, parsedValue, steps)
            : parsedValue;

          if (finalValue === null) {
            console.log(`[SNMP-Custom] ${device.name}: ${item.metric_name} — preprocessing için ilk ölçüm, bu turda yayınlanmadı`);
            continue;
          }

          await publishMetric({
            event_type: "metric",
            source_module: "npm",
            tenant_id: device.tenant_id,
            device_id: device.id,
            metric_name: item.metric_name,
            timestamp,
            value: finalValue,
            unit: item.unit || undefined
          });
          console.log(`[SNMP-Custom] ${device.name}: ${item.metric_name} = ${finalValue} (OID: ${item.oid})`);
        }
        settled = true;
        resolve();
      });
    } catch (err: any) {
      console.log(`[SNMP-Custom] ${device.name}: session.get senkron hata fırlattı: ${err.message}`);
      sessionError = err.message;
      settled = true;
      resolve();
    }
  });

  // Güvenlik ağı: 8 saniyede callback gelmezse zorla devam et, sonsuz askıda kalmayı önle.
  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      if (!settled) console.log(`[SNMP-Custom] ${device.name}: zaman aşımı (callback hiç gelmedi)`);
      resolve();
    }, 8000);
  });

  await Promise.race([getPromise, timeoutPromise]);

  try {
    session.close();
  } catch {
    // zaten kapanmış olabilir
  }
  return sessionError;
}

// ============ TABLO (WALK) TİPİ ITEM'LAR — is_table:true olan SNMP item'lar ============
// Zabbix'teki "discovery + item prototype" mantığının basitleştirilmiş karşılığı:
// bir OID sütununu (örn. ifInErrors) walk edip, her satırı (her interface/pool/vs.) ayrı
// bir metrik olarak, mümkünse okunur bir etiketle (label_oid varsa) yayınlıyoruz.

function walkOidColumn(session: any, baseOid: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const results: Record<string, string> = {};
    const prefix = baseOid + ".";
    session.walk(
      baseOid,
      20,
      (varbinds: any[]) => {
        for (const vb of varbinds) {
          if (snmp.isVarbindError(vb)) continue;
          const oidStr: string = vb.oid;
          // KRİTİK: taban OID'in alt ağacı dışına çıkan sonuçları ATLA — aksi halde
          // walk sınırı aşıp cihazın tüm MIB ağacını (yüzlerce alakasız OID) toplar.
          if (!oidStr.startsWith(prefix)) continue;
          const index = oidStr.slice(prefix.length);
          results[index] = vb.value.toString();
        }
      },
      (error: any) => {
        if (error) return reject(error);
        resolve(results);
      }
    );
  });
}

// Faz Queue-audit: fonksiyon/walk-seviyesi bir hata (varsa) donduruluyor.
export async function pollTableItem(device: DeviceRow, item: any, timestamp: string): Promise<string | undefined> {
  const valueOid = item.oid;
  const labelOid = item.connection_config?.label_oid;

  if (!valueOid) {
    const msg = "value OID tanımlı değil";
    console.log(`[SNMP-Table] ${device.name} ${item.metric_name}: ${msg}`);
    return msg;
  }

  const session = createSession(device);

  try {
    const values = await walkOidColumn(session, valueOid);
    const labels = labelOid ? await walkOidColumn(session, labelOid) : {};

    const rowCount = Object.keys(values).length;
    if (rowCount === 0) {
      const msg = `walk sonucu boş (OID: ${valueOid})`;
      console.log(`[SNMP-Table] ${device.name} ${item.metric_name}: ${msg}`);
      return msg;
    }

    let filterRegex: RegExp | null = null;
    if (item.discovery_filter_regex) {
      try {
        filterRegex = new RegExp(item.discovery_filter_regex);
      } catch {
        console.log(`[SNMP-Table] ${device.name} ${item.metric_name}: discovery_filter_regex geçersiz, filtre uygulanmadı`);
      }
    }

    let filteredCount = 0;
    for (const [index, rawValue] of Object.entries(values)) {
      const numValue = parseFloat(rawValue);
      if (Number.isNaN(numValue)) continue;

      const label = labels[index] || `#${index}`;

      // Discovery filter: label bu regex'e UYMUYORSA satır atlanır (örn. loopback
      // interface'leri hariç tutmak için "^(?!lo).*$" gibi bir desen kullanılabilir).
      if (filterRegex && !filterRegex.test(label)) {
        filteredCount++;
        continue;
      }
      const steps = item.preprocessing || [];
      // Tablo item'larında her satır (interface/pool) kendi bağımsız rate hesabına sahip
      // olmalı — cache key'e etiketi de dahil ediyoruz, aksi halde farklı interface'lerin
      // sayaçları birbirine karışır.
      const finalValue = steps.length > 0
        ? await applyPreprocessing(`${device.id}:${label}`, item.metric_name, numValue, steps)
        : numValue;

      if (finalValue === null) continue; // ilk ölçüm, rate henüz hesaplanamıyor

      await publishMetric({
        event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
        metric_name: item.metric_name, timestamp, value: finalValue, unit: item.unit || undefined,
        tags: { interface: label }
      });
    }
    const filterNote = filterRegex ? ` (${filteredCount} satır filtrelendi)` : "";
    console.log(`[SNMP-Table] ${device.name}: ${item.metric_name} — ${rowCount} satır toplandı (OID: ${valueOid})${filterNote}`);
    return undefined;
  } catch (err: any) {
    console.log(`[SNMP-Table] ${device.name} ${item.metric_name} hata: ${err.message}`);
    return err.message;
  } finally {
    session.close();
  }
}
