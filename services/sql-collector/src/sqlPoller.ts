import pg from "pg";
import mysql from "mysql2/promise";
import { publishMetric } from "./redisClient.js";
import { fetchResolvedConfig, reportCollectorStatus } from "./coreClient.js";
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

// Faz Queue-audit: erken-cikis noktalari ve catch bloğu artik bir hata mesaji
// (string) donduruyor -- oncesinde sadece console.log'a yazilip yutuluyordu.
export async function pollSqlItem(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<string | undefined> {
  const itemConfig = item.connection_config;
  if (!itemConfig?.query) {
    const msg = "query tanımlı değil";
    console.log(`[SQL] ${device.name} ${item.metric_name}: ${msg}`);
    return msg;
  }

  // connection_config içindeki {$SQL_PORT}/{$SQL_DATABASE}/{$SQL_USER}/{$SQL_PASSWORD} gibi
  // makro referanslarını bu cihaz için çözer — host hâlâ device.ip_address'ten gelir.
  const resolved = await fetchResolvedConfig(device.id, itemConfig);
  if (!resolved) {
    const msg = "bağlantı bilgisi çözülemedi (Core Service'e ulaşılamadı)";
    console.log(`[SQL] ${device.name} ${item.metric_name}: ${msg}`);
    return msg;
  }

  const username: string | undefined = resolved.username;
  const password: string | undefined = resolved.password ?? resolved.secret;
  const database: string | undefined = resolved.database;
  if (!username || !password || !database) {
    const msg = "SQL bağlantı bilgisi eksik — bu cihaz için ayarlanmamış";
    console.log(`[SQL] ${device.name} ${item.metric_name}: ${msg}`);
    return msg;
  }

  const defaultPort = item.collector_type === "sql_mysql" ? 3306 : 5432;
  const port = Number(resolved.port) || defaultPort;

  try {
    const value = item.collector_type === "sql_mysql"
      ? await runMysqlQuery(device.ip_address, port, database, username, password, itemConfig.query)
      : await runPostgresQuery(device.ip_address, port, database, username, password, itemConfig.query);

    if (value === null || Number.isNaN(value)) {
      const msg = "sonuç sayı değil veya boş";
      console.log(`[SQL] ${device.name} ${item.metric_name}: ${msg}`);
      return msg;
    }

    await publishMetric({
      event_type: "metric", source_module: "sql-collector", tenant_id: device.tenant_id, device_id: device.id,
      metric_name: item.metric_name, timestamp, value, unit: item.unit || undefined
    });
    console.log(`[SQL] ${device.name}: ${item.metric_name} = ${value}`);
    await reportCollectorStatus(device.id, "active", undefined, item.collector_type);
    return undefined;
  } catch (err: any) {
    console.log(`[SQL] ${device.name} ${item.metric_name} hata: ${err.message}`);
    await reportCollectorStatus(device.id, "down", err.message, item.collector_type);
    return err.message;
  }
}
