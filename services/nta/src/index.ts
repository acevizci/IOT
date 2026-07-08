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

// Cihaz bazlı örnekleme oranı — gerçek dünyada her exporter farklı oranla
// örnekleme yapabilir (örn. Cisco 1:1000, düşük hacimli cihaz 1:1 olabilir).
// Şimdilik ortam değişkeni ile global bir varsayılan tanımlıyoruz; ileride
// bu bilgi devices.attributes (JSONB) üzerinden cihaz bazlı okunabilir hale getirilir.
const DEFAULT_SAMPLING_RATE = Number(process.env.DEFAULT_SAMPLING_RATE) || 1;

interface CacheEntry {
  value: { deviceId: string; tenantId: string; samplingRate: number } | null;
  expiresAt: number;
}

const deviceCache = new Map<string, CacheEntry>();
const POSITIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 15 * 1000;

async function resolveDevice(exporterIp: string) {
  const cached = deviceCache.get(exporterIp);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const result = await pool.query(
    `SELECT id, tenant_id, attributes FROM devices WHERE ip_address = $1 LIMIT 1`,
    [exporterIp]
  );

  let resolved: { deviceId: string; tenantId: string; samplingRate: number } | null = null;
  if (result.rows.length > 0) {
    const row = result.rows[0];
    // Cihazın attributes alanında özel bir sampling_rate tanımlıysa onu kullan,
    // yoksa global varsayılana düş.
    const customRate = row.attributes?.netflow_sampling_rate;
    resolved = {
      deviceId: row.id,
      tenantId: row.tenant_id,
      samplingRate: typeof customRate === "number" && customRate > 0 ? customRate : DEFAULT_SAMPLING_RATE
    };
  }

  deviceCache.set(exporterIp, {
    value: resolved,
    expiresAt: Date.now() + (resolved ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS)
  });

  return resolved;
}

async function main() {
  await connectRedis();
  console.log(`[NTA] Redis bağlantısı kuruldu. Varsayılan sampling rate: 1:${DEFAULT_SAMPLING_RATE}`);

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
        packets: record.packets,
        sampling_rate: device.samplingRate
      });
    }
    console.log(`[NTA] ${rinfo.address} kaynağından ${records.length} flow işlendi (sampling 1:${device.samplingRate})`);
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
