import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.POSTGRES_HOST || "postgres",
  port: Number(process.env.POSTGRES_PORT) || 5432,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  max: 10
});

export async function checkDbConnection() {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://clickhouse:8123";
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || "";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || "";
const CLICKHOUSE_DB = process.env.CLICKHOUSE_DB || "observability_flows";

export async function queryClickHouse<T = any>(sql: string): Promise<T[]> {
  const auth = Buffer.from(`${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}`).toString("base64");
  const response = await fetch(`${CLICKHOUSE_URL}/?database=${CLICKHOUSE_DB}&default_format=JSONEachRow`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "text/plain" },
    body: sql
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ClickHouse sorgu hatası: ${response.status} ${errorText}`);
  }

  const text = await response.text();
  if (!text.trim()) return [];
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
