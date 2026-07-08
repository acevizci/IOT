const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://clickhouse:8123";
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || "obs_admin";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || "";
const CLICKHOUSE_DB = process.env.CLICKHOUSE_DB || "observability_flows";

export interface FlowRow {
  timestamp: string;
  tenant_id: string;
  device_id: string;
  src_ip: string;
  dst_ip: string;
  src_port: number;
  dst_port: number;
  protocol: number;
  bytes: number;
  packets: number;
  sampling_rate: number;
}

export async function insertFlows(rows: FlowRow[]): Promise<void> {
  if (rows.length === 0) return;

  const values = rows
    .map(
      (r) =>
        `('${r.timestamp.replace("T", " ").replace("Z", "")}', '${r.tenant_id}', '${r.device_id}', '${r.src_ip}', '${r.dst_ip}', ${r.src_port}, ${r.dst_port}, ${r.protocol}, ${r.bytes}, ${r.packets}, ${r.sampling_rate})`
    )
    .join(",");

  const query = `INSERT INTO flows (timestamp, tenant_id, device_id, src_ip, dst_ip, src_port, dst_port, protocol, bytes, packets, sampling_rate) VALUES ${values}`;

  const auth = Buffer.from(`${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}`).toString("base64");

  const response = await fetch(`${CLICKHOUSE_URL}/?database=${CLICKHOUSE_DB}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "text/plain" },
    body: query
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ClickHouse insert hatası: ${response.status} ${errorText}`);
  }
}
