import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  host: process.env.POSTGRES_HOST || "postgres",
  port: Number(process.env.POSTGRES_PORT) || 5432,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  max: 3
});

// RCA Confidence Motoru (madde 3): trafik materyalizasyonu TÜM tenant'lar için
// çalışır (flows-consumer, npm-service'in aksine tek bir tenant'a özgü değil,
// TÜM tenant'ların NetFlow verisini işler).
export async function getAllTenantIds(): Promise<string[]> {
  const result = await pool.query(`SELECT id FROM tenants`);
  return result.rows.map((r) => r.id);
}

// Cihaz IP'sini device_id'ye eşleştirmek için -- LLDP keşfindeki AYNI desen
// (device_interfaces öncelikli, yoksa devices.ip_address'e geri düş).
export async function getIpToDeviceIdMap(tenantId: string): Promise<Record<string, string>> {
  const result = await pool.query(
    `SELECT d.id, COALESCE(di.ip_address, host(d.ip_address)) as ip_address
     FROM devices d
     LEFT JOIN device_interfaces di ON di.device_id = d.id AND di.interface_type = 'snmp'
     WHERE d.tenant_id = $1`,
    [tenantId]
  );
  const map: Record<string, string> = {};
  for (const row of result.rows) {
    if (row.ip_address) map[row.ip_address] = row.id;
  }
  return map;
}

export async function upsertTrafficLink(tenantId: string, deviceAId: string, deviceBId: string, totalBytes: number): Promise<void> {
  await pool.query(
    `INSERT INTO traffic_links (tenant_id, device_a_id, device_b_id, total_bytes, last_updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tenant_id, LEAST(device_a_id, device_b_id), GREATEST(device_a_id, device_b_id))
     DO UPDATE SET total_bytes = $4, last_updated_at = now()`,
    [tenantId, deviceAId, deviceBId, totalBytes]
  );
}
