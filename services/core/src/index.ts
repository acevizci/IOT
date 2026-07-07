import Fastify from "fastify";
import { z } from "zod";
import { pool, checkDbConnection } from "./db.js";

const app = Fastify({ logger: true });

// --- Health check ---
app.get("/health", async () => {
  await checkDbConnection();
  return { status: "ok", service: "core-service" };
});

// --- Şimdilik sabit tenant_id (auth eklenene kadar geçici) ---
const TEMP_TENANT_ID = process.env.TEMP_TENANT_ID || null;

// --- Device oluşturma şeması ---
const CreateDeviceSchema = z.object({
  name: z.string().min(1),
  ip_address: z.string().ip(),
  device_type: z.enum(["switch", "firewall", "server", "load_balancer", "router"]),
  vendor: z.string().optional(),
  location: z.string().optional(),
  attributes: z.record(z.any()).optional()
});

// --- GET /api/v1/devices — tenant'a ait cihazları listele ---
app.get("/api/v1/devices", async (request, reply) => {
  const tenantId = request.headers["x-tenant-id"] || TEMP_TENANT_ID;
  if (!tenantId) {
    return reply.status(400).send({ error: "x-tenant-id header gerekli" });
  }

  const result = await pool.query(
    `SELECT id, name, ip_address, device_type, vendor, location, status, created_at
     FROM devices WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId]
  );
  return result.rows;
});

// --- POST /api/v1/devices — yeni cihaz ekle ---
app.post("/api/v1/devices", async (request, reply) => {
  const tenantId = request.headers["x-tenant-id"] || TEMP_TENANT_ID;
  if (!tenantId) {
    return reply.status(400).send({ error: "x-tenant-id header gerekli" });
  }

  const parsed = CreateDeviceSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const { name, ip_address, device_type, vendor, location, attributes } = parsed.data;

  const result = await pool.query(
    `INSERT INTO devices (tenant_id, name, ip_address, device_type, vendor, location, attributes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, name, ip_address, device_type, created_at`,
    [tenantId, name, ip_address, device_type, vendor || null, location || null, attributes || {}]
  );

  return reply.status(201).send(result.rows[0]);
});

const port = Number(process.env.PORT) || 3000;
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
