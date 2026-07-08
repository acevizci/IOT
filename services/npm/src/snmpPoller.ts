import snmp from "net-snmp";
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
