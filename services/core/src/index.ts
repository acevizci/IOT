import Fastify from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { pool, checkDbConnection } from "./db.js";
import { signToken } from "./auth.js";

const app = Fastify({ logger: true });

app.get("/health", async () => {
  await checkDbConnection();
  return { status: "ok", service: "core-service" };
});

const RegisterSchema = z.object({
  tenantName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8)
});

app.post("/api/v1/auth/register", async (request, reply) => {
  const parsed = RegisterSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { tenantName, email, password } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenantResult = await client.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [tenantName]);
    const tenantId = tenantResult.rows[0].id;
    const passwordHash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, 'admin') RETURNING id, email, role`,
      [tenantId, email, passwordHash]
    );
    await client.query("COMMIT");
    const user = userResult.rows[0];
    const token = signToken({ userId: user.id, tenantId, role: user.role, email: user.email });
    return reply.status(201).send({ token, tenantId, user });
  } catch (err: any) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return reply.status(409).send({ error: "Bu email zaten kayıtlı" });
    request.log.error(err);
    return reply.status(500).send({ error: "Kayıt sırasında hata oluştu" });
  } finally {
    client.release();
  }
});

const LoginSchema = z.object({ email: z.string().email(), password: z.string() });

app.post("/api/v1/auth/login", async (request, reply) => {
  const parsed = LoginSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { email, password } = parsed.data;

  const result = await pool.query(
    `SELECT id, tenant_id, email, password_hash, role FROM users WHERE email = $1`,
    [email]
  );
  if (result.rows.length === 0) return reply.status(401).send({ error: "Geçersiz email veya şifre" });

  const user = result.rows[0];
  const validPassword = await bcrypt.compare(password, user.password_hash);
  if (!validPassword) return reply.status(401).send({ error: "Geçersiz email veya şifre" });

  const token = signToken({ userId: user.id, tenantId: user.tenant_id, role: user.role, email: user.email });
  return { token };
});

app.addHook("onRequest", async (request, reply) => {
  const publicPaths = ["/health", "/api/v1/auth/register", "/api/v1/auth/login"];
  if (publicPaths.includes(request.url)) return;

  const tenantId = request.headers["x-auth-tenant-id"];
  const userId = request.headers["x-auth-user-id"];
  const role = request.headers["x-auth-role"];

  if (!tenantId || !userId) return reply.status(401).send({ error: "Kimlik doğrulama bilgisi eksik" });
  (request as any).auth = { tenantId, userId, role };
});

// ============ DEVICES ============
const CreateDeviceSchema = z.object({
  name: z.string().min(1),
  ip_address: z.string().ip(),
  device_type: z.enum(["switch", "firewall", "server", "load_balancer", "router"]),
  vendor: z.string().optional(),
  location: z.string().optional(),
  attributes: z.record(z.any()).optional()
});

app.get("/api/v1/devices", async (request) => {
  const auth = (request as any).auth;
  const query = request.query as { search?: string; status?: string; device_type?: string; limit?: string };

  const conditions: string[] = ["tenant_id = $1"];
  const params: any[] = [auth.tenantId];
  let paramIndex = 2;

  if (query.search) {
    conditions.push(`(name ILIKE $${paramIndex} OR ip_address::text ILIKE $${paramIndex})`);
    params.push(`%${query.search}%`);
    paramIndex++;
  }
  if (query.status) {
    conditions.push(`status = $${paramIndex}`);
    params.push(query.status);
    paramIndex++;
  }
  if (query.device_type) {
    conditions.push(`device_type = $${paramIndex}`);
    params.push(query.device_type);
    paramIndex++;
  }

  const limit = Math.min(Number(query.limit) || 50, 200);

  const result = await pool.query(
    `SELECT id, name, ip_address, device_type, vendor, location, status, created_at
     FROM devices WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC LIMIT ${limit}`,
    params
  );
  return result.rows;
});

// Cihaz tiplerinin/lokasyonların listesi (filtre dropdown'ları için)
app.get("/api/v1/devices/facets", async (request) => {
  const auth = (request as any).auth;
  const types = await pool.query(
    `SELECT DISTINCT device_type FROM devices WHERE tenant_id = $1 ORDER BY device_type`,
    [auth.tenantId]
  );
  const statuses = await pool.query(
    `SELECT DISTINCT status FROM devices WHERE tenant_id = $1 ORDER BY status`,
    [auth.tenantId]
  );
  return {
    device_types: types.rows.map((r) => r.device_type),
    statuses: statuses.rows.map((r) => r.status)
  };
});

app.get("/api/v1/devices/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  const result = await pool.query(
    `SELECT id, name, ip_address, device_type, vendor, location, status, attributes, created_at
     FROM devices WHERE tenant_id = $1 AND id = $2`,
    [auth.tenantId, id]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Cihaz bulunamadı" });
  return result.rows[0];
});

app.post("/api/v1/devices", async (request, reply) => {
  const auth = (request as any).auth;
  const parsed = CreateDeviceSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { name, ip_address, device_type, vendor, location, attributes } = parsed.data;

  const result = await pool.query(
    `INSERT INTO devices (tenant_id, name, ip_address, device_type, vendor, location, attributes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, name, ip_address, device_type, created_at`,
    [auth.tenantId, name, ip_address, device_type, vendor || null, location || null, attributes || {}]
  );
  return reply.status(201).send(result.rows[0]);
});

// ============ METRICS — hacme göre rollup seçimi (madde 2.6.2) ============
// Kısa aralık (<=3 saat): ham veri (1dk çözünürlük)
// Orta aralık (<=48 saat): metrics_5min rollup
// Uzun aralık (>48 saat): metrics_1hour rollup
app.get("/api/v1/metrics", async (request, reply) => {
  const auth = (request as any).auth;
  const query = request.query as { device_id?: string; metric_name?: string; hours?: string; interface?: string };

  if (!query.device_id) return reply.status(400).send({ error: "device_id gerekli" });

  const hours = Math.min(Number(query.hours) || 6, 720);

  let table: string;
  let timeCol: string;
  let valueCol: string;
  if (hours <= 3) {
    table = "metrics";
    timeCol = "time";
    valueCol = "value";
  } else if (hours <= 48) {
    table = "metrics_5min";
    timeCol = "bucket";
    valueCol = "avg_value";
  } else {
    table = "metrics_1hour";
    timeCol = "bucket";
    valueCol = "avg_value";
  }

  const params: any[] = [auth.tenantId, query.device_id, `${hours} hours`];
  let extraFilter = "";
  if (query.metric_name) {
    extraFilter += ` AND metric_name = $${params.length + 1}`;
    params.push(query.metric_name);
  }
  if (query.interface) {
    extraFilter += ` AND interface = $${params.length + 1}`;
    params.push(query.interface);
  }

  const result = await pool.query(
    `SELECT ${timeCol} as time, metric_name, interface, ${valueCol} as value
     FROM ${table}
     WHERE tenant_id = $1 AND device_id = $2 AND ${timeCol} >= now() - $3::interval${extraFilter}
     ORDER BY ${timeCol} ASC`,
    params
  );
  return { source: table, rows: result.rows };
});

app.get("/api/v1/metrics/names", async (request, reply) => {
  const auth = (request as any).auth;
  const query = request.query as { device_id?: string };
  if (!query.device_id) return reply.status(400).send({ error: "device_id gerekli" });

  const result = await pool.query(
    `SELECT DISTINCT metric_name, interface FROM metrics
     WHERE tenant_id = $1 AND device_id = $2 AND time >= now() - interval '24 hours'
     ORDER BY metric_name`,
    [auth.tenantId, query.device_id]
  );
  return result.rows;
});

// ============ ALERTS ============
app.get("/api/v1/alerts", async (request) => {
  const auth = (request as any).auth;
  const query = request.query as { status?: "open" | "resolved" };

  let statusFilter = "";
  if (query.status === "open") statusFilter = " AND a.resolved_at IS NULL";
  if (query.status === "resolved") statusFilter = " AND a.resolved_at IS NOT NULL";

  const result = await pool.query(
    `SELECT a.id, a.device_id, d.name as device_name, r.metric_name, a.triggered_at, a.resolved_at, a.severity, a.message
     FROM alerts a
     JOIN alert_rules r ON a.rule_id = r.id
     LEFT JOIN devices d ON a.device_id = d.id
     WHERE a.tenant_id = $1 ${statusFilter}
     ORDER BY a.triggered_at DESC LIMIT 200`,
    [auth.tenantId]
  );
  return result.rows;
});

// ============ ALERT RULES ============
const CreateRuleSchema = z.object({
  metric_name: z.string().min(1),
  condition: z.enum(["gt", "lt", "eq"]),
  threshold: z.number(),
  duration_seconds: z.number().min(30).default(60),
  device_id: z.string().uuid().nullable().optional()
});

app.get("/api/v1/alert-rules", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT r.id, r.metric_name, r.condition, r.threshold, r.duration_seconds, r.device_id, r.active, d.name as device_name
     FROM alert_rules r
     LEFT JOIN devices d ON r.device_id = d.id
     WHERE r.tenant_id = $1
     ORDER BY r.metric_name`,
    [auth.tenantId]
  );
  return result.rows;
});

app.post("/api/v1/alert-rules", async (request, reply) => {
  const auth = (request as any).auth;
  const parsed = CreateRuleSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { metric_name, condition, threshold, duration_seconds, device_id } = parsed.data;

  const result = await pool.query(
    `INSERT INTO alert_rules (tenant_id, source_module, metric_name, condition, threshold, duration_seconds, device_id)
     VALUES ($1, 'npm', $2, $3, $4, $5, $6)
     RETURNING id, metric_name, condition, threshold, duration_seconds, device_id, active`,
    [auth.tenantId, metric_name, condition, threshold, duration_seconds, device_id || null]
  );
  return reply.status(201).send(result.rows[0]);
});

app.patch("/api/v1/alert-rules/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  const body = request.body as { active?: boolean; threshold?: number; duration_seconds?: number };

  const result = await pool.query(
    `UPDATE alert_rules SET
       active = COALESCE($3, active),
       threshold = COALESCE($4, threshold),
       duration_seconds = COALESCE($5, duration_seconds)
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, metric_name, condition, threshold, duration_seconds, device_id, active`,
    [auth.tenantId, id, body.active, body.threshold, body.duration_seconds]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Kural bulunamadı" });
  return result.rows[0];
});

app.delete("/api/v1/alert-rules/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM alert_rules WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});

const port = Number(process.env.PORT) || 3000;
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
