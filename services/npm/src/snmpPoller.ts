import snmp from "net-snmp";
import type { DeviceRow } from "./db.js";
import { publishMetric } from "./redisClient.js";

// Standart OID'ler (MIB-2, hemen hemen her cihazda bulunur)
const OIDS = {
  sysUpTime: "1.3.6.1.2.1.1.3.0",
  sysDescr: "1.3.6.1.2.1.1.1.0"
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

export async function pollDevice(device: DeviceRow): Promise<void> {
  const session = createSession(device);
  const oids = [OIDS.sysUpTime];

  return new Promise((resolve) => {
    session.get(oids, async (error: any, varbinds: any[]) => {
      if (error) {
        console.error(`[SNMP] ${device.name} (${device.ip_address}) hata:`, error.message);
        session.close();
        return resolve();
      }

      const timestamp = new Date().toISOString();

      for (const vb of varbinds) {
        if (snmp.isVarbindError(vb)) {
          console.error(`[SNMP] ${device.name} varbind hatası:`, snmp.varbindError(vb));
          continue;
        }

        if (vb.oid === OIDS.sysUpTime) {
          // Timeticks -> saniye (100'e bölünür, SNMP standardı)
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
          console.log(`[SNMP] ${device.name}: uptime = ${uptimeSeconds}s`);
        }
      }

      session.close();
      resolve();
    });
  });
}
