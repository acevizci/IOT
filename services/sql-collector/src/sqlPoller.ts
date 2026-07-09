import pg from "pg";
import mysql from "mysql2/promise";
import { publishMetric } from "./redisClient.js";
import type { DeviceRow, EffectiveItem } from "./coreClient.js";

async function runPostgresQuery(connectionString: string, query: string): Promise<number | null> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const result = await client.query(query);
    const firstRow = result.rows[0];
    if (!firstRow) return null;
    const firstValue = Object.values(firstRow)[0];
    return Number(firstValue);
  } finally {
    await client.end().catch(() => {});
  }
}

async function runMysqlQuery(connectionString: string, query: string): Promise<number | null> {
  const connection = await mysql.createConnection({ uri: connectionString, connectTimeout: 5000 });
  try {
    const [rows] = await connection.query(query);
    const firstRow = (rows as any[])[0];
    if (!firstRow) return null;
    const firstValue = Object.values(firstRow)[0];
    return Number(firstValue);
  } finally {
    await connection.end().catch(() => {});
  }
}

export async function pollSqlItem(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<void> {
  const connectionString = item.connection_config?.connection_string;
  const query = item.connection_config?.query;

  if (!connectionString || !query) {
    console.log(`[SQL] ${device.name} ${item.metric_name}: connection_string veya query eksik`);
    return;
  }

  try {
    const value = item.collector_type === "sql_mysql"
      ? await runMysqlQuery(connectionString, query)
      : await runPostgresQuery(connectionString, query);

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
