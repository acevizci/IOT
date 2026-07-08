import Fastify from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { pool, checkDbConnection, queryClickHouse } from "./db.js";
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

    // Varsayılan roller: Admin (tam yetki) ve Viewer (sadece görüntüleme)
    const adminRoleResult = await client.query(
      `INSERT INTO user_roles (tenant_id, name, can_edit_devices, can_edit_alert_rules, can_manage_users)
       VALUES ($1, 'Admin', true, true, true) RETURNING id`,
      [tenantId]
    );
    await client.query(
      `INSERT INTO user_roles (tenant_id, name, can_edit_devices, can_edit_alert_rules, can_manage_users)
       VALUES ($1, 'Viewer', false, false, false)`,
      [tenantId]
    );
    const adminRoleId = adminRoleResult.rows[0].id;

    const passwordHash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, role, role_id) VALUES ($1, $2, $3, 'admin', $4) RETURNING id, email, role`,
      [tenantId, email, passwordHash, adminRoleId]
    );
    await client.query("COMMIT");
    const user = userResult.rows[0];
    const token = signToken({
      userId: user.id, tenantId, role: user.role, email: user.email,
      canEditDevices: true, canEditAlertRules: true, canManageUsers: true
    });
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
    `SELECT u.id, u.tenant_id, u.email, u.password_hash, u.role,
            COALESCE(r.can_edit_devices, u.role = 'admin') as can_edit_devices,
            COALESCE(r.can_edit_alert_rules, u.role = 'admin') as can_edit_alert_rules,
            COALESCE(r.can_manage_users, u.role = 'admin') as can_manage_users
     FROM users u
     LEFT JOIN user_roles r ON r.id = u.role_id
     WHERE u.email = $1`,
    [email]
  );
  if (result.rows.length === 0) return reply.status(401).send({ error: "Geçersiz email veya şifre" });

  const user = result.rows[0];
  const validPassword = await bcrypt.compare(password, user.password_hash);
  if (!validPassword) return reply.status(401).send({ error: "Geçersiz email veya şifre" });

  const token = signToken({
    userId: user.id, tenantId: user.tenant_id, role: user.role, email: user.email,
    canEditDevices: user.can_edit_devices, canEditAlertRules: user.can_edit_alert_rules, canManageUsers: user.can_manage_users
  });
  return { token };
});

app.addHook("onRequest", async (request, reply) => {
  const publicPaths = ["/health", "/api/v1/auth/register", "/api/v1/auth/login"];
  if (publicPaths.includes(request.url)) return;

  const tenantId = request.headers["x-auth-tenant-id"];
  const userId = request.headers["x-auth-user-id"];
  const role = request.headers["x-auth-role"];
  const canEditDevices = request.headers["x-auth-can-edit-devices"] === "true";
  const canEditAlertRules = request.headers["x-auth-can-edit-alert-rules"] === "true";
  const canManageUsers = request.headers["x-auth-can-manage-users"] === "true";

  if (!tenantId || !userId) return reply.status(401).send({ error: "Kimlik doğrulama bilgisi eksik" });
  (request as any).auth = { tenantId, userId, role, canEditDevices, canEditAlertRules, canManageUsers };
});

// ============ DEVICES ============
const CreateDeviceSchema = z.object({
  name: z.string().min(1),
  ip_address: z.string().ip(),
  device_type: z.enum(["switch", "firewall", "server", "load_balancer", "router"]),
  vendor: z.string().optional(),
  location: z.string().optional(),
  tags: z.array(z.string()).optional(),
  attributes: z.record(z.any()).optional()
});

const UpdateDeviceSchema = z.object({
  name: z.string().min(1).optional(),
  vendor: z.string().optional(),
  location: z.string().optional(),
  tags: z.array(z.string()).optional(),
  attributes: z.record(z.any()).optional()
});

app.get("/api/v1/devices", async (request) => {
  const auth = (request as any).auth;
  const query = request.query as { search?: string; status?: string; device_type?: string; tag?: string; limit?: string };

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
  if (query.tag) {
    conditions.push(`attributes->'tags' ? $${paramIndex}`);
    params.push(query.tag);
    paramIndex++;
  }

  const limit = Math.min(Number(query.limit) || 50, 200);

  const result = await pool.query(
    `SELECT id, name, ip_address, device_type, vendor, location, status, attributes, created_at
     FROM devices WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC LIMIT ${limit}`,
    params
  );
  return result.rows;
});

// Tüm benzersiz tag'lerin listesi (filtre dropdown'ı için)
app.get("/api/v1/devices/tags", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT DISTINCT jsonb_array_elements_text(attributes->'tags') as tag
     FROM devices WHERE tenant_id = $1 AND attributes ? 'tags'
     ORDER BY tag`,
    [auth.tenantId]
  );
  return result.rows.map((r) => r.tag);
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
  const { name, ip_address, device_type, vendor, location, tags, attributes } = parsed.data;

  const finalAttributes = { ...(attributes || {}), ...(tags ? { tags } : {}) };

  try {
    const result = await pool.query(
      `INSERT INTO devices (tenant_id, name, ip_address, device_type, vendor, location, attributes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, ip_address, device_type, created_at`,
      [auth.tenantId, name, ip_address, device_type, vendor || null, location || null, finalAttributes]
    );
    return reply.status(201).send(result.rows[0]);
  } catch (err: any) {
    if (err.code === "23505") {
      return reply.status(409).send({ error: `Bu IP adresi (${ip_address}) zaten kayıtlı bir cihaza ait` });
    }
    request.log.error(err);
    return reply.status(500).send({ error: "Cihaz eklenirken hata oluştu" });
  }
});

// Cihaz güncelleme (isim, vendor, lokasyon, tag, attributes)
app.patch("/api/v1/devices/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  const parsed = UpdateDeviceSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { name, vendor, location, tags, attributes } = parsed.data;

  const existing = await pool.query(`SELECT attributes FROM devices WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  if (existing.rows.length === 0) return reply.status(404).send({ error: "Cihaz bulunamadı" });

  const mergedAttributes = {
    ...existing.rows[0].attributes,
    ...(attributes || {}),
    ...(tags !== undefined ? { tags } : {})
  };

  const result = await pool.query(
    `UPDATE devices SET
       name = COALESCE($3, name),
       vendor = COALESCE($4, vendor),
       location = COALESCE($5, location),
       attributes = $6
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, name, ip_address, device_type, vendor, location, status, attributes`,
    [auth.tenantId, id, name, vendor, location, mergedAttributes]
  );
  return result.rows[0];
});

// Cihaz silme
app.delete("/api/v1/devices/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditDevices) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM devices WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});

// Toplu silme (mass update — Zabbix'teki "mass update" mantığı)
app.post("/api/v1/devices/bulk-delete", async (request, reply) => {
  const auth = (request as any).auth;
  const body = request.body as { ids: string[] };
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return reply.status(400).send({ error: "ids listesi gerekli" });
  }
  await pool.query(`DELETE FROM devices WHERE tenant_id = $1 AND id = ANY($2)`, [auth.tenantId, body.ids]);
  return { deleted: body.ids.length };
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
  device_id: z.string().uuid().nullable().optional(),
  severity: z.enum(["info", "warning", "average", "high", "disaster"]).default("warning")
});

app.get("/api/v1/alert-rules", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT r.id, r.metric_name, r.condition, r.threshold, r.duration_seconds, r.device_id, r.active, r.severity, d.name as device_name
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
  const { metric_name, condition, threshold, duration_seconds, device_id, severity } = parsed.data;

  const result = await pool.query(
    `INSERT INTO alert_rules (tenant_id, source_module, metric_name, condition, threshold, duration_seconds, device_id, severity)
     VALUES ($1, 'npm', $2, $3, $4, $5, $6, $7)
     RETURNING id, metric_name, condition, threshold, duration_seconds, device_id, active, severity`,
    [auth.tenantId, metric_name, condition, threshold, duration_seconds, device_id || null, severity]
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
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM alert_rules WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});


// ============ TRAFFIC (NTA — ClickHouse sorguları) ============

// Top Talkers: belirli bir zaman aralığında en çok trafik üreten IP çiftleri
app.get("/api/v1/traffic/top-talkers", async (request, reply) => {
  const auth = (request as any).auth;
  const query = request.query as { hours?: string; limit?: string };
  const hours = Math.min(Number(query.hours) || 1, 168);
  const limit = Math.min(Number(query.limit) || 20, 100);

  try {
    // sampling_rate ile çarpma: örneklenmiş flow verisinden gerçek tahmini trafiği hesaplar.
    // sampling_rate=1 ise (örnekleme yok) sonuç değişmez; 1:1000 gibi bir oranda ise
    // gerçek trafik 1000 kat daha yüksektir, bunu yansıtmazsak rakamlar ciddi yanıltıcı olur.
    const rows = await queryClickHouse(`
      SELECT
        src_ip,
        dst_ip,
        sum(bytes * sampling_rate) AS total_bytes,
        sum(packets * sampling_rate) AS total_packets,
        count(*) AS flow_count
      FROM flows
      WHERE tenant_id = '${auth.tenantId}' AND timestamp >= now() - INTERVAL ${hours} HOUR
      GROUP BY src_ip, dst_ip
      ORDER BY total_bytes DESC
      LIMIT ${limit}
    `);
    return rows;
  } catch (err: any) {
    request.log.error(err);
    return reply.status(500).send({ error: "Trafik sorgusu başarısız" });
  }
});

// Protokol/port dağılımı
app.get("/api/v1/traffic/protocol-breakdown", async (request, reply) => {
  const auth = (request as any).auth;
  const query = request.query as { hours?: string };
  const hours = Math.min(Number(query.hours) || 1, 168);

  try {
    const rows = await queryClickHouse(`
      SELECT
        dst_port,
        protocol,
        sum(bytes * sampling_rate) AS total_bytes,
        count(*) AS flow_count
      FROM flows
      WHERE tenant_id = '${auth.tenantId}' AND timestamp >= now() - INTERVAL ${hours} HOUR
      GROUP BY dst_port, protocol
      ORDER BY total_bytes DESC
      LIMIT 15
    `);
    return rows;
  } catch (err: any) {
    request.log.error(err);
    return reply.status(500).send({ error: "Trafik sorgusu başarısız" });
  }
});

// Genel trafik özeti (toplam bytes/flow sayısı — KPI kartları için)
app.get("/api/v1/traffic/summary", async (request, reply) => {
  const auth = (request as any).auth;
  const query = request.query as { hours?: string };
  const hours = Math.min(Number(query.hours) || 1, 168);

  try {
    const rows = await queryClickHouse(`
      SELECT
        sum(bytes * sampling_rate) AS total_bytes,
        sum(packets * sampling_rate) AS total_packets,
        count(*) AS flow_count,
        count(DISTINCT src_ip) AS unique_sources,
        count(DISTINCT dst_ip) AS unique_destinations
      FROM flows
      WHERE tenant_id = '${auth.tenantId}' AND timestamp >= now() - INTERVAL ${hours} HOUR
    `);
    return rows[0] || { total_bytes: 0, total_packets: 0, flow_count: 0, unique_sources: 0, unique_destinations: 0 };
  } catch (err: any) {
    request.log.error(err);
    return reply.status(500).send({ error: "Trafik sorgusu başarısız" });
  }
});


// Cihazın en son bilinen tüm metrik değerleri (Zabbix "Latest Data" mantığı)
app.get("/api/v1/devices/:id/latest-data", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  const result = await pool.query(
    `SELECT DISTINCT ON (metric_name, interface)
       metric_name, interface, value, unit, time
     FROM metrics
     WHERE tenant_id = $1 AND device_id = $2 AND time >= now() - interval '1 hour'
     ORDER BY metric_name, interface, time DESC`,
    [auth.tenantId, id]
  );
  return result.rows;
});


// ============ TOPOLOGY ============

const CreateLinkSchema = z.object({
  device_a_id: z.string().uuid(),
  device_b_id: z.string().uuid(),
  interface_a: z.string().optional(),
  interface_b: z.string().optional()
});

// Manuel bağlantı ekle (LLDP olmadığı için kullanıcı elle tanımlıyor)
app.post("/api/v1/topology/links", async (request, reply) => {
  const auth = (request as any).auth;
  const parsed = CreateLinkSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { device_a_id, device_b_id, interface_a, interface_b } = parsed.data;

  const result = await pool.query(
    `INSERT INTO device_links (tenant_id, device_a_id, device_b_id, interface_a, interface_b)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, device_a_id, device_b_id, interface_a, interface_b`,
    [auth.tenantId, device_a_id, device_b_id, interface_a || null, interface_b || null]
  );
  return reply.status(201).send(result.rows[0]);
});

app.delete("/api/v1/topology/links/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM device_links WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});

// Topoloji görünümü: cihazlar (node) + manuel bağlantılar + trafik bazlı kenarlar
app.get("/api/v1/topology", async (request, reply) => {
  const auth = (request as any).auth;
  const query = request.query as { hours?: string };
  const hours = Math.min(Number(query.hours) || 24, 168);

  const devicesResult = await pool.query(
    `SELECT id, name, ip_address, device_type, status FROM devices WHERE tenant_id = $1`,
    [auth.tenantId]
  );
  const devices = devicesResult.rows;

  const linksResult = await pool.query(
    `SELECT id, device_a_id, device_b_id, interface_a, interface_b FROM device_links WHERE tenant_id = $1`,
    [auth.tenantId]
  );

  // Trafik bazlı kenarlar: flows tablosundaki src_ip/dst_ip'yi devices.ip_address ile eşleştir.
  // Sadece HER İKİ ucu da bizim izlediğimiz cihazlardan biri olan trafiği gösteriyoruz
  // (dış internet trafiği topoloji grafiğinde gürültü yaratır).
  let trafficEdges: any[] = [];
  try {
    const ipToDeviceId: Record<string, string> = {};
    for (const d of devices) ipToDeviceId[d.ip_address] = d.id;

    const flowRows = await queryClickHouse(`
      SELECT src_ip, dst_ip, sum(bytes * sampling_rate) AS total_bytes
      FROM flows
      WHERE tenant_id = '${auth.tenantId}' AND timestamp >= now() - INTERVAL ${hours} HOUR
      GROUP BY src_ip, dst_ip
    `);

    for (const row of flowRows) {
      const srcDeviceId = ipToDeviceId[row.src_ip];
      const dstDeviceId = ipToDeviceId[row.dst_ip];
      if (srcDeviceId && dstDeviceId && srcDeviceId !== dstDeviceId) {
        trafficEdges.push({
          device_a_id: srcDeviceId,
          device_b_id: dstDeviceId,
          total_bytes: Number(row.total_bytes)
        });
      }
    }
  } catch (err) {
    request.log.warn("Topoloji trafik sorgusu başarısız (ClickHouse boş olabilir): " + err);
  }

  return {
    nodes: devices,
    manualLinks: linksResult.rows,
    trafficEdges
  };
});


// ============ DEVICE GROUPS (Host Groups) ============

const CreateGroupSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional()
});

app.get("/api/v1/device-groups", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT g.id, g.name, g.description, g.created_at,
            COUNT(m.device_id)::int as member_count
     FROM device_groups g
     LEFT JOIN device_group_members m ON m.device_group_id = g.id
     WHERE g.tenant_id = $1
     GROUP BY g.id
     ORDER BY g.name`,
    [auth.tenantId]
  );
  return result.rows;
});

app.get("/api/v1/device-groups/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  const groupResult = await pool.query(
    `SELECT id, name, description, created_at FROM device_groups WHERE tenant_id = $1 AND id = $2`,
    [auth.tenantId, id]
  );
  if (groupResult.rows.length === 0) return reply.status(404).send({ error: "Grup bulunamadı" });

  const membersResult = await pool.query(
    `SELECT d.id, d.name, d.ip_address, d.device_type, d.status
     FROM device_group_members m
     JOIN devices d ON d.id = m.device_id
     WHERE m.device_group_id = $1
     ORDER BY d.name`,
    [id]
  );

  return { ...groupResult.rows[0], members: membersResult.rows };
});

app.post("/api/v1/device-groups", async (request, reply) => {
  const auth = (request as any).auth;
  const parsed = CreateGroupSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  try {
    const result = await pool.query(
      `INSERT INTO device_groups (tenant_id, name, description) VALUES ($1, $2, $3)
       RETURNING id, name, description, created_at`,
      [auth.tenantId, parsed.data.name, parsed.data.description || null]
    );
    return reply.status(201).send(result.rows[0]);
  } catch (err: any) {
    if (err.code === "23505") return reply.status(409).send({ error: "Bu isimde bir grup zaten var" });
    throw err;
  }
});

app.delete("/api/v1/device-groups/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM device_groups WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});

const MembersSchema = z.object({ device_ids: z.array(z.string().uuid()) });

app.post("/api/v1/device-groups/:id/members", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  const parsed = MembersSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const groupCheck = await pool.query(`SELECT id FROM device_groups WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  if (groupCheck.rows.length === 0) return reply.status(404).send({ error: "Grup bulunamadı" });

  for (const deviceId of parsed.data.device_ids) {
    await pool.query(
      `INSERT INTO device_group_members (device_group_id, device_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [id, deviceId]
    );
  }
  return reply.status(201).send({ added: parsed.data.device_ids.length });
});

app.delete("/api/v1/device-groups/:id/members/:deviceId", async (request, reply) => {
  const { id, deviceId } = request.params as { id: string; deviceId: string };
  await pool.query(
    `DELETE FROM device_group_members WHERE device_group_id = $1 AND device_id = $2`,
    [id, deviceId]
  );
  return reply.status(204).send();
});


// ============ ALERT TEMPLATES ============

const CreateTemplateSchema = z.object({
  name: z.string().min(1),
  device_type: z.string().optional(),
  rules: z.array(z.object({
    metric_name: z.string().min(1),
    condition: z.enum(["gt", "lt", "eq"]),
    threshold: z.number(),
    duration_seconds: z.number().min(30).default(60),
    severity: z.enum(["info", "warning", "average", "high", "disaster"]).default("warning")
  })).min(1)
});

app.get("/api/v1/alert-templates", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT t.id, t.name, t.device_type, t.created_at,
            COUNT(DISTINCT r.id)::int as rule_count,
            COUNT(DISTINCT ar.device_id)::int as device_count
     FROM alert_templates t
     LEFT JOIN alert_template_rules r ON r.template_id = t.id
     LEFT JOIN alert_rules ar ON ar.template_rule_id = r.id
     WHERE t.tenant_id = $1
     GROUP BY t.id
     ORDER BY t.name`,
    [auth.tenantId]
  );
  return result.rows;
});

app.get("/api/v1/alert-templates/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  const templateResult = await pool.query(
    `SELECT id, name, device_type, created_at FROM alert_templates WHERE tenant_id = $1 AND id = $2`,
    [auth.tenantId, id]
  );
  if (templateResult.rows.length === 0) return reply.status(404).send({ error: "Şablon bulunamadı" });

  const rulesResult = await pool.query(
    `SELECT id, metric_name, condition, threshold, duration_seconds, severity
     FROM alert_template_rules WHERE template_id = $1 ORDER BY metric_name`,
    [id]
  );

  return { ...templateResult.rows[0], rules: rulesResult.rows };
});

app.post("/api/v1/alert-templates", async (request, reply) => {
  const auth = (request as any).auth;
  const parsed = CreateTemplateSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { name, device_type, rules } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const templateResult = await client.query(
      `INSERT INTO alert_templates (tenant_id, name, device_type) VALUES ($1, $2, $3) RETURNING id`,
      [auth.tenantId, name, device_type || null]
    );
    const templateId = templateResult.rows[0].id;

    for (const rule of rules) {
      await client.query(
        `INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [templateId, rule.metric_name, rule.condition, rule.threshold, rule.duration_seconds, rule.severity]
      );
    }
    await client.query("COMMIT");
    return reply.status(201).send({ id: templateId, name, device_type, rules });
  } catch (err: any) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return reply.status(409).send({ error: "Bu isimde bir şablon zaten var" });
    throw err;
  } finally {
    client.release();
  }
});

app.delete("/api/v1/alert-templates/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM alert_templates WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});

// Şablonu bir device group'a uygula: gruptaki HER cihaz için template kurallarının
// birer KOPYASINI alert_rules'a ekler (referans değil — cihaz sonradan bağımsızlaşabilir).
const ApplyTemplateSchema = z.object({ device_group_id: z.string().uuid() });

app.post("/api/v1/alert-templates/:id/apply", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  const parsed = ApplyTemplateSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const rulesResult = await pool.query(
    `SELECT id, metric_name, condition, threshold, duration_seconds, severity
     FROM alert_template_rules WHERE template_id = $1`,
    [id]
  );
  if (rulesResult.rows.length === 0) return reply.status(404).send({ error: "Şablonda kural yok veya şablon bulunamadı" });

  const membersResult = await pool.query(
    `SELECT device_id FROM device_group_members WHERE device_group_id = $1`,
    [parsed.data.device_group_id]
  );
  const deviceIds = membersResult.rows.map((r) => r.device_id);

  let created = 0;
  for (const deviceId of deviceIds) {
    for (const rule of rulesResult.rows) {
      await pool.query(
        `INSERT INTO alert_rules (tenant_id, source_module, metric_name, condition, threshold, duration_seconds, device_id, severity, template_rule_id)
         VALUES ($1, 'npm', $2, $3, $4, $5, $6, $7, $8)`,
        [auth.tenantId, rule.metric_name, rule.condition, rule.threshold, rule.duration_seconds, deviceId, rule.severity, rule.id]
      );
      created++;
    }
  }

  return { appliedToDevices: deviceIds.length, rulesCreated: created };
});


// ============ USER MANAGEMENT ============

app.get("/api/v1/users", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canManageUsers) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const result = await pool.query(
    `SELECT u.id, u.email, u.created_at, r.id as role_id, r.name as role_name
     FROM users u
     LEFT JOIN user_roles r ON r.id = u.role_id
     WHERE u.tenant_id = $1
     ORDER BY u.created_at`,
    [auth.tenantId]
  );
  return result.rows;
});

app.get("/api/v1/user-roles", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT id, name, can_edit_devices, can_edit_alert_rules, can_manage_users
     FROM user_roles WHERE tenant_id = $1 ORDER BY name`,
    [auth.tenantId]
  );
  return result.rows;
});

const CreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role_id: z.string().uuid()
});

app.post("/api/v1/users", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canManageUsers) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const parsed = CreateUserSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { email, password, role_id } = parsed.data;

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, role, role_id)
       VALUES ($1, $2, $3, 'operator', $4)
       RETURNING id, email, created_at`,
      [auth.tenantId, email, passwordHash, role_id]
    );
    return reply.status(201).send(result.rows[0]);
  } catch (err: any) {
    if (err.code === "23505") return reply.status(409).send({ error: "Bu email zaten kayıtlı" });
    throw err;
  }
});

app.delete("/api/v1/users/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canManageUsers) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  if (id === auth.userId) return reply.status(400).send({ error: "Kendi hesabınızı silemezsiniz" });
  await pool.query(`DELETE FROM users WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});


// ============ MEDIA TYPES & NOTIFICATIONS ============

const CreateMediaTypeSchema = z.object({
  type: z.enum(["email", "webhook"]),
  name: z.string().min(1),
  config: z.record(z.any()).default({})
});

app.get("/api/v1/media-types", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT id, type, name, config, active FROM media_types WHERE tenant_id = $1 ORDER BY name`,
    [auth.tenantId]
  );
  return result.rows;
});

app.post("/api/v1/media-types", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canManageUsers) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const parsed = CreateMediaTypeSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const result = await pool.query(
    `INSERT INTO media_types (tenant_id, type, name, config) VALUES ($1, $2, $3, $4)
     RETURNING id, type, name, config, active`,
    [auth.tenantId, parsed.data.type, parsed.data.name, parsed.data.config]
  );
  return reply.status(201).send(result.rows[0]);
});

app.delete("/api/v1/media-types/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canManageUsers) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM media_types WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});

const CreateUserMediaSchema = z.object({
  media_type_id: z.string().uuid(),
  destination: z.string().min(1),
  device_group_id: z.string().uuid().nullable().optional(),
  min_severity: z.enum(["info", "warning", "average", "high", "disaster"]).default("warning")
});

app.get("/api/v1/user-media", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT um.id, um.destination, um.min_severity, um.active,
            mt.type as media_type, mt.name as media_type_name,
            dg.name as device_group_name
     FROM user_media um
     JOIN media_types mt ON mt.id = um.media_type_id
     LEFT JOIN device_groups dg ON dg.id = um.device_group_id
     WHERE um.user_id = $1
     ORDER BY um.id`,
    [auth.userId]
  );
  return result.rows;
});

app.post("/api/v1/user-media", async (request, reply) => {
  const auth = (request as any).auth;
  const parsed = CreateUserMediaSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { media_type_id, destination, device_group_id, min_severity } = parsed.data;

  const result = await pool.query(
    `INSERT INTO user_media (user_id, media_type_id, destination, device_group_id, min_severity)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, destination, min_severity`,
    [auth.userId, media_type_id, destination, device_group_id || null, min_severity]
  );
  return reply.status(201).send(result.rows[0]);
});

app.delete("/api/v1/user-media/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM user_media WHERE id = $1 AND user_id = $2`, [id, auth.userId]);
  return reply.status(204).send();
});


// ============ TEMPLATE ITEMS (dinamik SNMP OID tanımları) ============

const CreateItemSchema = z.object({
  metric_name: z.string().min(1),
  oid: z.string().min(1),
  data_type: z.enum(["gauge", "counter", "string"]).default("gauge"),
  unit: z.string().optional(),
  polling_interval_seconds: z.number().min(10).default(60),
  is_table: z.boolean().default(false)
});

app.get("/api/v1/alert-templates/:id/items", async (request) => {
  const { id } = request.params as { id: string };
  const result = await pool.query(
    `SELECT id, metric_name, oid, data_type, unit, polling_interval_seconds, is_table
     FROM template_items WHERE template_id = $1 ORDER BY metric_name`,
    [id]
  );
  return result.rows;
});

app.post("/api/v1/alert-templates/:id/items", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  const parsed = CreateItemSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const { metric_name, oid, data_type, unit, polling_interval_seconds, is_table } = parsed.data;
  const result = await pool.query(
    `INSERT INTO template_items (template_id, metric_name, oid, data_type, unit, polling_interval_seconds, is_table)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, metric_name, oid, data_type, unit, polling_interval_seconds, is_table`,
    [id, metric_name, oid, data_type, unit || null, polling_interval_seconds, is_table]
  );
  return reply.status(201).send(result.rows[0]);
});

app.delete("/api/v1/template-items/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM template_items WHERE id = $1`, [id]);
  return reply.status(204).send();
});

// Bir cihaza template ata (device_templates ilişkisi)
const AssignTemplateSchema = z.object({ template_id: z.string().uuid() });

app.post("/api/v1/devices/:id/templates", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditDevices) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  const parsed = AssignTemplateSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  await pool.query(
    `INSERT INTO device_templates (device_id, template_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [id, parsed.data.template_id]
  );
  return reply.status(201).send({ device_id: id, template_id: parsed.data.template_id });
});

app.get("/api/v1/devices/:id/templates", async (request) => {
  const { id } = request.params as { id: string };
  const result = await pool.query(
    `SELECT t.id, t.name FROM device_templates dt JOIN alert_templates t ON t.id = dt.template_id WHERE dt.device_id = $1`,
    [id]
  );
  return result.rows;
});

app.delete("/api/v1/devices/:id/templates/:templateId", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditDevices) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id, templateId } = request.params as { id: string; templateId: string };
  await pool.query(`DELETE FROM device_templates WHERE device_id = $1 AND template_id = $2`, [id, templateId]);
  return reply.status(204).send();
});

// Bir cihazın "etkin" item listesi — atanmış TÜM template'lerin (ve ebeveynlerinin,
// template linking sayesinde) item'larının birleşimi. NPM Service bu endpoint'i
// kullanarak hangi OID'leri hangi cihazdan çekeceğini öğrenir — kod içinde sabit
// OID listesi YOKTUR, her şey buradan gelir.
app.get("/api/v1/devices/:id/effective-items", async (request) => {
  const { id } = request.params as { id: string };

  // Cihaza atanmış doğrudan template'ler
  const directTemplates = await pool.query(
    `SELECT template_id FROM device_templates WHERE device_id = $1`,
    [id]
  );

  // Her template için ebeveyn zincirini de dahil et (basit tek seviyeli linking,
  // ileride çok seviyeli recursive CTE'ye genişletilebilir)
  const templateIds = new Set<string>();
  for (const row of directTemplates.rows) {
    templateIds.add(row.template_id);
    const parentResult = await pool.query(
      `SELECT parent_template_id FROM alert_templates WHERE id = $1 AND parent_template_id IS NOT NULL`,
      [row.template_id]
    );
    if (parentResult.rows[0]?.parent_template_id) {
      templateIds.add(parentResult.rows[0].parent_template_id);
    }
  }

  if (templateIds.size === 0) return [];

  const itemsResult = await pool.query(
    `SELECT DISTINCT metric_name, oid, data_type, unit, polling_interval_seconds, is_table
     FROM template_items WHERE template_id = ANY($1::uuid[])`,
    [Array.from(templateIds)]
  );
  return itemsResult.rows;
});


// ============ RELATIONS (çapraz bağlantı verileri — dashboard "İlişkiler" panelleri için) ============

app.get("/api/v1/devices/:id/relations", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  const deviceCheck = await pool.query(`SELECT id FROM devices WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  if (deviceCheck.rows.length === 0) return reply.status(404).send({ error: "Cihaz bulunamadı" });

  const groupsResult = await pool.query(
    `SELECT g.id, g.name FROM device_group_members m
     JOIN device_groups g ON g.id = m.device_group_id
     WHERE m.device_id = $1`,
    [id]
  );

  const templatesResult = await pool.query(
    `SELECT t.id, t.name,
            (SELECT COUNT(*)::int FROM template_items ti WHERE ti.template_id = t.id) as item_count,
            (SELECT COUNT(*)::int FROM alert_template_rules r WHERE r.template_id = t.id) as rule_count
     FROM device_templates dt JOIN alert_templates t ON t.id = dt.template_id
     WHERE dt.device_id = $1`,
    [id]
  );

  const rulesResult = await pool.query(
    `SELECT r.id, r.metric_name, r.condition, r.threshold, r.duration_seconds, r.severity,
            (r.template_rule_id IS NOT NULL) as from_template
     FROM alert_rules r WHERE r.device_id = $1 ORDER BY r.metric_name`,
    [id]
  );

  const notificationsResult = await pool.query(
    `SELECT um.destination, um.min_severity, mt.type as media_type
     FROM user_media um
     JOIN media_types mt ON mt.id = um.media_type_id
     JOIN users u ON u.id = um.user_id
     WHERE u.tenant_id = $1
       AND (um.device_group_id IS NULL OR um.device_group_id IN (
         SELECT device_group_id FROM device_group_members WHERE device_id = $2
       ))`,
    [auth.tenantId, id]
  );

  return {
    device_groups: groupsResult.rows,
    templates: templatesResult.rows,
    alert_rules: rulesResult.rows,
    notification_targets: notificationsResult.rows
  };
});

// Host Group detayına uygulanan template geçmişi
app.get("/api/v1/device-groups/:id/applied-templates", async (request) => {
  const { id } = request.params as { id: string };
  const result = await pool.query(
    `SELECT DISTINCT t.id, t.name,
            (SELECT COUNT(DISTINCT r.device_id)::int
             FROM alert_rules r
             JOIN alert_template_rules atr ON atr.id = r.template_rule_id
             WHERE atr.template_id = t.id
               AND r.device_id IN (SELECT device_id FROM device_group_members WHERE device_group_id = $1)
            ) as applied_device_count
     FROM alert_templates t
     JOIN alert_template_rules atr ON atr.template_id = t.id
     JOIN alert_rules r ON r.template_rule_id = atr.id
     WHERE r.device_id IN (SELECT device_id FROM device_group_members WHERE device_group_id = $1)`,
    [id]
  );
  return result.rows;
});


// Bu şablonu (template) kullanan cihazların listesi
app.get("/api/v1/alert-templates/:id/devices", async (request) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  const result = await pool.query(
    `SELECT DISTINCT d.id, d.name, d.ip_address, d.device_type, d.status
     FROM devices d
     JOIN alert_rules r ON r.device_id = d.id
     JOIN alert_template_rules atr ON atr.id = r.template_rule_id
     WHERE atr.template_id = $1 AND d.tenant_id = $2
     ORDER BY d.name`,
    [id, auth.tenantId]
  );
  return result.rows;
});

const port = Number(process.env.PORT) || 3000;
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
