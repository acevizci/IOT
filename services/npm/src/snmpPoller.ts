import snmp from "net-snmp";
import { evaluate } from "mathjs";
import type { DeviceRow } from "./db.js";
import { publishMetric } from "./redisClient.js";

const OIDS = {
  sysUpTime: "1.3.6.1.2.1.1.3.0",
  ifTable: "1.3.6.1.2.1.2.2",
  laLoad1min: "1.3.6.1.4.1.2021.10.1.3.1",
  memAvailReal: "1.3.6.1.4.1.2021.4.6.0",
  memTotalReal: "1.3.6.1.4.1.2021.4.5.0"
};

const IF_COLUMNS = {
  ifDescr: 2,
  ifOperStatus: 8,
  ifInOctets: 10,
  ifOutOctets: 16
};

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

async function pollInterfaces(session: any, device: DeviceRow, timestamp: string) {
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
        const inOctets = Number(row[IF_COLUMNS.ifInOctets]);
        const outOctets = Number(row[IF_COLUMNS.ifOutOctets]);

        await publishMetric({
          event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
          metric_name: "if_oper_status", timestamp, value: operStatus, unit: "status", tags: { interface: ifDescr }
        });
        if (!Number.isNaN(inOctets)) {
          await publishMetric({
            event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
            metric_name: "if_in_octets", timestamp, value: inOctets, unit: "bytes", tags: { interface: ifDescr }
          });
        }
        if (!Number.isNaN(outOctets)) {
          await publishMetric({
            event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
            metric_name: "if_out_octets", timestamp, value: outOctets, unit: "bytes", tags: { interface: ifDescr }
          });
        }
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

export async function pollEffectiveItems(
  device: DeviceRow,
  items: EffectiveItem[],
  timestamp: string
): Promise<void> {
  if (items.length === 0) return;

  const session = createSession(device);

  // Formül tabanlı (türetilmiş) metrikleri ayrı işle — bunlar birden fazla OID gerektirir.
  const formulaItems = items.filter((i) => i.formula && i.formula_oids);
  for (const item of formulaItems) {
    await pollFormulaItem(session, device, item, timestamp);
  }

  const singleOidItems = items.filter((i) => !i.is_table && !i.formula && i.oid);
  if (singleOidItems.length === 0) {
    session.close();
    return;
  }

  // Session seviyesinde beklenmedik hataları yakala (aksi halde unhandled 'error'
  // event'i callback'i hiç tetiklemeden sessizce asılı kalmaya sebep olabilir).
  session.on("error", (err: any) => {
    console.log(`[SNMP] ${device.name} custom item session hatası: ${err?.message || err}`);
  });

  const oids = singleOidItems.map((i) => i.oid);
  console.log(`[SNMP-Custom] ${device.name}: ${oids.length} özel OID sorgulanıyor...`);

  let settled = false;

  const getPromise = new Promise<void>((resolve) => {
    try {
      session.get(oids, async (error: any, varbinds: any[]) => {
        if (settled) return;
        if (error) {
          console.log(`[SNMP] ${device.name} custom item hata: ${error.message}`);
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
          const value = item.data_type === "string" ? null : parseFloat(rawValue.toString());
          if (value === null || Number.isNaN(value)) continue;

          await publishMetric({
            event_type: "metric",
            source_module: "npm",
            tenant_id: device.tenant_id,
            device_id: device.id,
            metric_name: item.metric_name,
            timestamp,
            value,
            unit: item.unit || undefined
          });
          console.log(`[SNMP-Custom] ${device.name}: ${item.metric_name} = ${value} (OID: ${item.oid})`);
        }
        settled = true;
        resolve();
      });
    } catch (err: any) {
      console.log(`[SNMP-Custom] ${device.name}: session.get senkron hata fırlattı: ${err.message}`);
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
}
