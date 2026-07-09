import pg from "pg";
import mysql from "mysql2/promise";
import { publishMetric } from "./redisClient.js";
import { fetchDeviceSqlConfig, fetchCredential } from "./coreClient.js";
import type { DeviceRow, EffectiveItem } from "./coreClient.js";

async function runPostgresQuery(host: string, port: number, database: string, username: string, password: string, query: string): Promise<number | null> {
  const client = new pg.Client({ host, port, database, user: username, password, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const result = await client.query(query);
    const firstRow = result.rows[0];
    if (!firstRow) return null;
    return Number(Object.values(firstRow)[0]);
  } finally {
    await client.end().catch(() => {});
  }
}

async function runMysqlQuery(host: string, port: number, database: string, username: string, password: string, query: string): Promise<number | null> {
  const connection = await mysql.createConnection({ host, port, database, user: username, password, connectTimeout: 5000 });
  try {
    const [rows] = await connection.query(query);
    const firstRow = (rows as any[])[0];
    if (!firstRow) return null;
    return Number(Object.values(firstRow)[0]);
  } finally {
    await connection.end().catch(() => {});
  }
}

export async function pollSqlItem(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<void> {
  const query = item.connection_config?.query; // template item'da SADECE sorgu var
  if (!query) {
    console.log(`[SQL] ${device.name} ${item.metric_name}: query tanımlı değil`);
    return;
  }

  // Bağlantı bilgisi (port, database, credential) cihazın kendi config'inden gelir
  const sqlConfig = await fetchDeviceSqlConfig(device.id, item.collector_type);
  if (!sqlConfig?.credential_id || !sqlConfig?.database) {
    console.log(`[SQL] ${device.name} ${item.metric_name}: cihaz için SQL bağlantı ayarı tanımlanmamış (Device Detail > Bağlantı Ayarları)`);
    return;
  }

  const credential = await fetchCredential(sqlConfig.credential_id);
  if (!credential) {
    console.log(`[SQL] ${device.name} ${item.metric_name}: kimlik bilgisi bulunamadı`);
    return;
  }

  const defaultPort = item.collector_type === "sql_mysql" ? 3306 : 5432;

  try {
    const value = item.collector_type === "sql_mysql"
      ? await runMysqlQuery(device.ip_address, sqlConfig.port || defaultPort, sqlConfig.database, credential.username, credential.secret, query)
      : await runPostgresQuery(device.ip_address, sqlConfig.port || defaultPort, sqlConfig.database, credential.username, credential.secret, query);

    if (value === null || Number.isNaN(value)) {
      console.log(`[SQL] ${device.name} ${item.metric_name}: sonuç sayı değil veya boş`);
      return;
    }

    await publishMetric({
      event_type: "metric", source_module: "sql-collector", tenant_id: device.tenant_id, device_id: device.id,
      metric_name: item.metric_name, timestamp, value, unit: item.unit || undefined
    });
    console.log(`[SQL] ${device.name}: ${item.metric_name} = ${value}`);
  } catch (err: any) {
    console.log(`[SQL] ${device.name} ${item.metric_name} hata: ${err.message}`);
  }
}
