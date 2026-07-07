import Fastify from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { pool, checkDbConnection } from "./db.js";
import { signToken, verifyToken } from "./auth.js";

const app = Fastify({ logger: true });

// --- Health check ---
app.get("/health", async () => {
  await checkDbConnection();
  return { status: "ok", service: "core-service" };
});

// --- Auth: yeni tenant + ilk admin kullanıcı kaydı ---
const RegisterSchema = z.object({
  tenantName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8)
});

app.post("/api/v1/auth/register", async (request, reply) => {
  const parsed = RegisterSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }
  const { tenantName, email, password } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tenantResult = await client.query(
      `INSERT INTO tenants (name) VALUES ($1) RETURNING id`,
      [tenantName]
    );
    const tenantId = tenantResult.rows[0].id;

    const passwordHash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'admin') RETURNING id, email, role`,
      [tenantId, email, passwordHash]
    );

    await client.query("COMMIT");

    const user = userResult.rows[0];
    const token = signToken({
      userId: user.id,
      tenantId,
      role: user.role,
      email: user.email
    });

    return reply.status(201).send({ token, tenantId, user });
  } catch (err: any) {
    await client.query("ROLLBACK");
    if (err.code === "23505") {
      return reply.status(409).send({ error: "Bu email zaten kayıtlı" });
    }
    request.log.error(err);
    return reply.status(500).send({ error: "Kayıt sırasında hata oluştu" });
  } finally {
    client.release();
  }
});

// --- Auth: giriş ---
const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string()
});

app.post("/api/v1/auth/login", async (request, reply) => {
  const parsed = LoginSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }
  const { email, password } = parsed.data;

  const result = await pool.query(
    `SELECT id, tenant_id, email, password_hash, role FROM users WHERE email = $1`,
    [email]
  );

  if (result.rows.length === 0) {
    return reply.status(401).send({ error: "Geçersiz email veya şifre" });
  }

  const user = result.rows[0];
  const validPassword = await bcrypt.compare(password, user.password_hash);
  if (!validPassword) {
    return reply.status(401).send({ error: "Geçersiz email veya şifre" });
  }

  const token = signToken({
    userId: user.id,
    tenantId: user.tenant_id,
    role: user.role,
    email: user.email
  });

  return { token };
});

// --- Auth middleware: Authorization header'dan JWT doğrula ---
app.addHook("onRequest", async (request, reply) => {
  const publicPaths = ["/health", "/api/v1/auth/register", "/api/v1/auth/login"];
  if (publicPaths.includes(request.url)) return;

  const authHeader = request.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return reply.status(401).send({ error: "Authorization header eksik" });
  }

  try {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    (request as any).auth = payload;
  } catch {
    return reply.status(401).send({ error: "Geçersiz veya süresi dolmuş token" });
  }
});

// --- Device şeması ---
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
  const result = await pool.query(
    `SELECT id, name, ip_address, device_type, vendor, location, status, created_at
     FROM devices WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [auth.tenantId]
  );
  return result.rows;
});

app.post("/api/v1/devices", async (request, reply) => {
  const auth = (request as any).auth;
  const parsed = CreateDeviceSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }
  const { name, ip_address, device_type, vendor, location, attributes } = parsed.data;

  const result = await pool.query(
    `INSERT INTO devices (tenant_id, name, ip_address, device_type, vendor, location, attributes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, name, ip_address, device_type, created_at`,
    [auth.tenantId, name, ip_address, device_type, vendor || null, location || null, attributes || {}]
  );

  return reply.status(201).send(result.rows[0]);
});

const port = Number(process.env.PORT) || 3000;
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
