import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.POSTGRES_HOST || "postgres",
  port: Number(process.env.POSTGRES_PORT) || 5432,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  max: 5
});

export interface DeviceRow {
  id: string;
  tenant_id: string;
  name: string;
  ip_address: string;
  snmp_config: { community?: string; port?: number } | null;
}

// "active" veya "down" olan, ve SNMP polling'i devre dışı bırakılmamış cihazlar izlenir.
// attributes.monitoring_type = 'netflow_only' olan cihazlar (sadece trafik export eden,
// SNMP agent'ı olmayan exporter'lar) bu listeye hiç girmez.
export async function getActiveDevices(): Promise<DeviceRow[]> {
  const result = await pool.query(
    `SELECT id, tenant_id, name, ip_address, snmp_config
     FROM devices
     WHERE status IN ('active', 'down')
       AND COALESCE(attributes->>'monitoring_type', 'snmp') != 'netflow_only'`
  );
  return result.rows;
}

export async function updateDeviceStatus(deviceId: string, status: "active" | "down") {
  await pool.query(`UPDATE devices SET status = $1 WHERE id = $2 AND status != $1`, [status, deviceId]);
}

// SNMP collector'ının kendi ayrı erişilebilirlik durumunu Core Service'e bildirir
// (device_collector_status tablosu — Zabbix'in her interface-tipi için ayrı durum
// modeli). Mevcut updateDeviceStatus'a EK olarak çağrılır, onu değiştirmez.
const CORE_SERVICE_URL = process.env.CORE_SERVICE_URL || "http://core-service:3000";
export async function reportCollectorStatus(deviceId: string, status: "active" | "down", error?: string) {
  try {
    await fetch(`${CORE_SERVICE_URL}/api/v1/internal/devices/${deviceId}/collector-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET || "" },
      body: JSON.stringify({ collector_type: "snmp", status, error })
    });
  } catch (err) {
    console.error(`[NPM] collector-status bildirimi başarısız (device=${deviceId}):`, err);
  }
}
