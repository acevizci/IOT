import dgram from "dgram";
import pg from "pg";
import { parseNetflowV5 } from "./netflowParser.js";
import { connectRedis, publishFlow } from "./redisClient.js";

const { Pool } = pg;

const pool = new Pool({
  host: process.env.POSTGRES_HOST || "postgres",
  port: Number(process.env.POSTGRES_PORT) || 5432,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  max: 5
});

const LISTEN_PORT = Number(process.env.NETFLOW_PORT) || 2055;

interface CacheEntry {
  value: { deviceId: string; tenantId: string } | null;
  expiresAt: number;
}

// Pozitif sonuçlar uzun süre (cihaz nadiren değişir), negatif sonuçlar kısa süre
// cache'lenir (böylece cihaz sonradan eklendiğinde servis yeniden başlatılmadan
// otomatik olarak tanır).
const deviceCache = new Map<string, CacheEntry>();
const POSITIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 15 * 1000;

async function resolveDevice(exporterIp: string) {
  const cached = deviceCache.get(exporterIp);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const result = await pool.query(
    `SELECT id, tenant_id FROM devices WHERE ip_address = $1 LIMIT 1`,
    [exporterIp]
  );

  const resolved = result.rows.length > 0
    ? { deviceId: result.rows[0].id, tenantId: result.rows[0].tenant_id }
    : null;

  deviceCache.set(exporterIp, {
    value: resolved,
    expiresAt: Date.now() + (resolved ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS)
  });

  return resolved;
}

async function main() {
  await connectRedis();
  console.log("[NTA] Redis bağlantısı kuruldu.");

  const socket = dgram.createSocket("udp4");

  socket.on("message", async (msg, rinfo) => {
    const records = parseNetflowV5(msg);
    if (records.length === 0) return;

    const device = await resolveDevice(rinfo.address);
    if (!device) {
      console.log(`[NTA] Bilinmeyen exporter IP: ${rinfo.address}, ${records.length} flow atlandı`);
      return;
    }

    const timestamp = new Date().toISOString();
    for (const record of records) {
      await publishFlow({
        event_type: "flow",
        source_module: "nta",
        tenant_id: device.tenantId,
        device_id: device.deviceId,
        timestamp,
        src_ip: record.srcAddr,
        dst_ip: record.dstAddr,
        src_port: record.srcPort,
        dst_port: record.dstPort,
        protocol: record.protocol,
        bytes: record.bytes,
        packets: record.packets
      });
    }
    console.log(`[NTA] ${rinfo.address} kaynağından ${records.length} flow işlendi`);
  });

  socket.on("error", (err) => {
    console.error("[NTA] Socket hatası:", err);
  });

  socket.bind(LISTEN_PORT, "0.0.0.0", () => {
    console.log(`[NTA] NetFlow v5 dinleyici hazır: UDP ${LISTEN_PORT}`);
  });
}

main().catch((err) => {
  console.error("[NTA] Başlatma hatası:", err);
  process.exit(1);
});
