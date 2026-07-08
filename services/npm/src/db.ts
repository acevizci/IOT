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

// "active" veya "down" olan tüm cihazlar izlenmeye devam eder — sadece
// "maintenance"/"decommissioned" gibi kalıcı olarak dışlanan cihazlar filtrelenir.
// Böylece "down" bir cihaz tekrar erişilebilir hale geldiğinde otomatik "active"e döner.
export async function getActiveDevices(): Promise<DeviceRow[]> {
  const result = await pool.query(
    `SELECT id, tenant_id, name, ip_address, snmp_config
     FROM devices WHERE status IN ('active', 'down')`
  );
  return result.rows;
}

export async function updateDeviceStatus(deviceId: string, status: "active" | "down") {
  await pool.query(`UPDATE devices SET status = $1 WHERE id = $2 AND status != $1`, [status, deviceId]);
}
