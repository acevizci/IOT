import type { ParsedSpan } from "./otlpParser.js";

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://clickhouse:8123";
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || "obs_admin";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || "";
const CLICKHOUSE_DB = process.env.CLICKHOUSE_DB || "observability_flows";

// flows-consumer/clickhouse.ts'teki insertFlows ile AYNI JSONEachRow deseni --
// Map(String,String) alanı için ClickHouse'un JSONEachRow formatı düz bir
// JSON objesi bekliyor, biz de attributes'u öyle gönderiyoruz.
export async function insertTraces(tenantId: string, rows: ParsedSpan[]): Promise<void> {
  if (rows.length === 0) return;

  const lines = rows
    .map((r) =>
      JSON.stringify({
        timestamp: r.timestamp,
        tenant_id: tenantId,
        trace_id: r.trace_id,
        span_id: r.span_id,
        parent_span_id: r.parent_span_id,
        service_name: r.service_name,
        operation_name: r.operation_name,
        duration_ms: r.duration_ms,
        status_code: r.status_code,
        kind: r.kind,
        attributes: r.attributes
      })
    )
    .join("\n");

  const auth = Buffer.from(`${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}`).toString("base64");
  const response = await fetch(
    `${CLICKHOUSE_URL}/?database=${CLICKHOUSE_DB}&query=${encodeURIComponent("INSERT INTO traces FORMAT JSONEachRow")}`,
    {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-ndjson" },
      body: lines
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ClickHouse trace insert hatası: ${response.status} ${errorText}`);
  }
}
