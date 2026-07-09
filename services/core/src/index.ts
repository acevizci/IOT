import Fastify from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { pool, checkDbConnection, queryClickHouse } from "./db.js";
import { signToken } from "./auth.js";

const app = Fastify({ logger: true });

async function idsBelongToTenant(table: string, ids: string[], tenantId: string): Promise<boolean> {
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) return true;
  const result = await pool.query(
    `SELECT COUNT(*)::int as count FROM ${table} WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenantId, uniqueIds]
  );
  return result.rows[0].count === uniqueIds.length;
}

async function idBelongsToTenant(table: string, id: string, tenantId: string): Promise<boolean> {
  return idsBelongToTenant(table, [id], tenantId);
}

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
  const email = request.headers["x-auth-email"] as string;

  if (!tenantId || !userId) return reply.status(401).send({ error: "Kimlik doğrulama bilgisi eksik" });
  (request as any).auth = { tenantId, userId, role, canEditDevices, canEditAlertRules, canManageUsers, email };
});

// Merkezi audit log: sadece değiştirici (POST/PATCH/PUT/DELETE) istekleri kaydeder.
// GET istekleri loglanmaz (gürültü olur, "kim ne değiştirdi" sorusuna cevap vermez).
const AUDITED_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const AUDIT_EXCLUDED_PATHS = ["/api/v1/auth/register", "/api/v1/auth/login"];
const SENSITIVE_KEY_PATTERN = /password|secret|token|api[_-]?key/i;

// request/response gövdesindeki şifre/secret gibi alanları [gizli] ile değiştirir —
// audit_log'a düz metin şifre/SMTP parolası gibi hassas veri sızmasın diye.
function redactSensitive(value: any): any {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (typeof value === "object") {
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[gizli]" : redactSensitive(val);
    }
    return result;
  }
  return value;
}

// onResponse yerine onSend kullanıyoruz çünkü yanıt gövdesine (payload) sadece
// burada erişebiliyoruz — PATCH/POST endpoint'leri güncel/oluşturulan satırı
// döndürdüğü için bu bize ayrı bir "önce" sorgusu yapmadan doğal bir "sonra"
// görüntüsü veriyor.
app.addHook("onSend", async (request, reply, payload) => {
  if (!AUDITED_METHODS.has(request.method)) return payload;
  if (AUDIT_EXCLUDED_PATHS.includes(request.url.split("?")[0])) return payload;

  const auth = (request as any).auth;
  if (!auth) return payload;

  try {
    const sanitizedRequestBody = request.body ? redactSensitive(request.body) : null;

    let responseBody: any = null;
    if (typeof payload === "string" && payload.length > 0 && payload.length < 10000) {
      try {
        responseBody = JSON.parse(payload);
      } catch {
        // JSON değilse (örn. boş 204 gövdesi) yoksay
      }
    }
    const sanitizedResponseBody = responseBody ? redactSensitive(responseBody) : null;

    await pool.query(
      `INSERT INTO audit_log (tenant_id, user_id, user_email, method, path, status_code, request_body, response_body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        auth.tenantId,
        auth.userId,
        auth.email || "bilinmiyor",
        request.method,
        request.url,
        reply.statusCode,
        sanitizedRequestBody ? JSON.stringify(sanitizedRequestBody) : null,
        sanitizedResponseBody ? JSON.stringify(sanitizedResponseBody) : null
      ]
    );
  } catch (err) {
    request.log.error(err, "Audit log yazma hatası");
  }

  return payload;
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
  const query = request.query as { search?: string; status?: string; device_type?: string; tag?: string; limit?: string; page?: string };

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
  const page = Math.max(Number(query.page) || 1, 1);
  const offset = (page - 1) * limit;

  // COUNT(*) OVER() ile toplam kayıt sayısını aynı sorguda alıyoruz —
  // ayrı bir COUNT sorgusu göndermeye gerek kalmıyor.
  const result = await pool.query(
    `SELECT id, name, ip_address, device_type, vendor, location, status, attributes, created_at,
            COUNT(*) OVER()::int as total_count
     FROM devices WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  const total = result.rows[0]?.total_count ?? 0;
  const items = result.rows.map(({ total_count, ...rest }) => rest);

  return { items, total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) };
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
  const query = request.query as { device_id?: string; metric_name?: string; hours?: string; interface?: string; from?: string; to?: string };

  if (!query.device_id) return reply.status(400).send({ error: "device_id gerekli" });

  // from/to verilmişse (örn. bir alarmın tetiklendiği ana odaklanmak için) mutlak
  // zaman aralığı kullanılır; verilmemişse eski davranış ("şu andan X saat önce") geçerli.
  const useAbsoluteRange = !!(query.from && query.to);
  const hours = useAbsoluteRange
    ? Math.max((new Date(query.to!).getTime() - new Date(query.from!).getTime()) / 3_600_000, 0.1)
    : Math.min(Number(query.hours) || 6, 720);

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

  const params: any[] = [auth.tenantId, query.device_id];
  let timeFilter: string;
  if (useAbsoluteRange) {
    params.push(query.from, query.to);
    timeFilter = `${timeCol} >= $3 AND ${timeCol} <= $4`;
  } else {
    params.push(`${hours} hours`);
    timeFilter = `${timeCol} >= now() - $3::interval`;
  }

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
     WHERE tenant_id = $1 AND device_id = $2 AND ${timeFilter}${extraFilter}
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
  const query = request.query as {
    status?: "open" | "resolved";
    severity?: string;
    device_id?: string;
    from?: string;
    to?: string;
    limit?: string;
    page?: string;
  };

  const conditions: string[] = ["a.tenant_id = $1"];
  const params: any[] = [auth.tenantId];
  let paramIndex = 2;

  if (query.status === "open") conditions.push("a.resolved_at IS NULL");
  if (query.status === "resolved") conditions.push("a.resolved_at IS NOT NULL");
  if (query.severity) {
    conditions.push(`a.severity = $${paramIndex}`);
    params.push(query.severity);
    paramIndex++;
  }
  if (query.device_id) {
    conditions.push(`a.device_id = $${paramIndex}`);
    params.push(query.device_id);
    paramIndex++;
  }
  if (query.from) {
    conditions.push(`a.triggered_at >= $${paramIndex}`);
    params.push(query.from);
    paramIndex++;
  }
  if (query.to) {
    conditions.push(`a.triggered_at <= $${paramIndex}`);
    params.push(query.to);
    paramIndex++;
  }

  const limit = Math.min(Number(query.limit) || 50, 200);
  const page = Math.max(Number(query.page) || 1, 1);
  const offset = (page - 1) * limit;

  const result = await pool.query(
    `SELECT a.id, a.device_id, d.name as device_name, r.metric_name, a.triggered_at, a.resolved_at, a.severity, a.message,
            a.acknowledged_at, a.acknowledged_by,
            COUNT(*) OVER()::int as total_count
     FROM alerts a
     JOIN alert_rules r ON a.rule_id = r.id
     LEFT JOIN devices d ON a.device_id = d.id
     WHERE ${conditions.join(" AND ")}
     ORDER BY a.triggered_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  const total = result.rows[0]?.total_count ?? 0;
  const items = result.rows.map(({ total_count, ...rest }) => rest);

  return { items, total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) };
});

// Bir alarmın tüm detayı: kural tanımı, cihaz, yorumlar, bildirim gönderim geçmişi,
// bu alarm yüzünden bastırılmış (suppress edilmiş) diğer alarmlar.
app.get("/api/v1/alerts/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  const alertResult = await pool.query(
    `SELECT a.id, a.device_id, d.name as device_name, d.ip_address, d.device_type,
            a.rule_id, a.metric_name, a.condition, a.threshold, a.value,
            a.triggered_at, a.resolved_at, a.severity, a.message,
            a.acknowledged_at, a.acknowledged_by, u.email as acknowledged_by_email,
            r.duration_seconds, r.active as rule_active, (r.template_rule_id IS NOT NULL) as from_template
     FROM alerts a
     LEFT JOIN devices d ON d.id = a.device_id
     LEFT JOIN alert_rules r ON r.id = a.rule_id
     LEFT JOIN users u ON u.id = a.acknowledged_by
     WHERE a.tenant_id = $1 AND a.id = $2`,
    [auth.tenantId, id]
  );
  if (alertResult.rows.length === 0) return reply.status(404).send({ error: "Alarm bulunamadı" });
  const alert = alertResult.rows[0];

  const commentsResult = await pool.query(
    `SELECT c.id, c.comment, c.created_at, u.email as user_email
     FROM alert_comments c JOIN users u ON u.id = c.user_id
     WHERE c.alert_id = $1 ORDER BY c.created_at ASC`,
    [id]
  );

  const deliveriesResult = await pool.query(
    `SELECT nd.id, nd.channel_type, nd.destination, nd.status, nd.error_message, nd.sent_at, mt.name as media_type_name
     FROM notification_deliveries nd
     LEFT JOIN media_types mt ON mt.id = nd.media_type_id
     WHERE nd.alert_id = $1 ORDER BY nd.sent_at ASC`,
    [id]
  );

  // Bu alarmın kuralına bağımlı olan başka kurallardan, aynı cihazda bu alarm
  // yüzünden bastırılmış alarmlar (varsa) — "bu alarm neyi susturdu" görünürlüğü.
  const suppressedByThisResult = await pool.query(
    `SELECT sa.id, sa.message, sa.suppressed_at, r.metric_name
     FROM suppressed_alerts sa
     JOIN alert_rules r ON r.id = sa.rule_id
     WHERE sa.depends_on_rule_id = $1 AND sa.device_id = $2
     ORDER BY sa.suppressed_at DESC`,
    [alert.rule_id, alert.device_id]
  );

  return {
    ...alert,
    comments: commentsResult.rows,
    notification_deliveries: deliveriesResult.rows,
    suppressed_by_this: suppressedByThisResult.rows
  };
});

app.post("/api/v1/alerts/:id/acknowledge", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  const result = await pool.query(
    `UPDATE alerts SET acknowledged_at = now(), acknowledged_by = $1
     WHERE tenant_id = $2 AND id = $3
     RETURNING id, acknowledged_at, acknowledged_by`,
    [auth.userId, auth.tenantId, id]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Alarm bulunamadı" });
  return result.rows[0];
});

app.delete("/api/v1/alerts/:id/acknowledge", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  await pool.query(
    `UPDATE alerts SET acknowledged_at = NULL, acknowledged_by = NULL WHERE tenant_id = $1 AND id = $2`,
    [auth.tenantId, id]
  );
  return reply.status(204).send();
});

const AddCommentSchema = z.object({ comment: z.string().min(1) });

app.post("/api/v1/alerts/:id/comments", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  const parsed = AddCommentSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const alertCheck = await pool.query(`SELECT id FROM alerts WHERE id = $1 AND tenant_id = $2`, [id, auth.tenantId]);
  if (alertCheck.rows.length === 0) return reply.status(404).send({ error: "Alarm bulunamadı" });

  const result = await pool.query(
    `INSERT INTO alert_comments (alert_id, user_id, comment) VALUES ($1, $2, $3)
     RETURNING id, comment, created_at`,
    [id, auth.userId, parsed.data.comment]
  );
  return reply.status(201).send({ ...result.rows[0], user_email: auth.email });
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

  if (!(await idsBelongToTenant("devices", [device_a_id, device_b_id], auth.tenantId))) {
    return reply.status(404).send({ error: "Cihazlardan biri veya ikisi de bulunamadı" });
  }

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
  const auth = (request as any).auth;
  const { id, deviceId } = request.params as { id: string; deviceId: string };
  if (!(await idBelongsToTenant("device_groups", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Grup bulunamadı" });
  }
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
  tags: z.array(z.string()).optional(),
  parent_template_id: z.string().uuid().nullable().optional(),
  rules: z.array(z.object({
    metric_name: z.string().min(1),
    condition: z.enum(["gt", "lt", "eq"]),
    threshold: z.number().optional(), // threshold_macro_key varsa gerekmez
    threshold_macro_key: z.string().optional(), // örn. "{$MEM_THRESHOLD}"
    duration_seconds: z.number().min(30).default(60),
    severity: z.enum(["info", "warning", "average", "high", "disaster"]).default("warning"),
    depends_on_index: z.number().nullable().optional()
  })).min(1)
});

app.get("/api/v1/alert-templates", async (request) => {
  const auth = (request as any).auth;
  const query = request.query as { search?: string; tag?: string };

  const conditions: string[] = ["t.tenant_id = $1"];
  const params: any[] = [auth.tenantId];
  let paramIndex = 2;

  if (query.search) {
    conditions.push(`t.name ILIKE $${paramIndex}`);
    params.push(`%${query.search}%`);
    paramIndex++;
  }
  if (query.tag) {
    conditions.push(`t.tags ? $${paramIndex}`);
    params.push(query.tag);
    paramIndex++;
  }

  const result = await pool.query(
    `SELECT t.id, t.name, t.device_type, t.created_at, t.tags, t.parent_template_id,
            pt.name as parent_template_name,
            COUNT(DISTINCT r.id)::int as rule_count,
            COUNT(DISTINCT ti.id)::int as item_count,
            COUNT(DISTINCT ar.device_id)::int as device_count
     FROM alert_templates t
     LEFT JOIN alert_templates pt ON pt.id = t.parent_template_id
     LEFT JOIN alert_template_rules r ON r.template_id = t.id
     LEFT JOIN template_items ti ON ti.template_id = t.id
     LEFT JOIN alert_rules ar ON ar.template_rule_id = r.id
     WHERE ${conditions.join(" AND ")}
     GROUP BY t.id, pt.name
     ORDER BY t.name`,
    params
  );
  return result.rows;
});

// Tüm benzersiz template tag'lerinin listesi (filtre dropdown'ı için)
app.get("/api/v1/alert-templates/tags", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT DISTINCT jsonb_array_elements_text(tags) as tag
     FROM alert_templates WHERE tenant_id = $1 AND jsonb_array_length(tags) > 0
     ORDER BY tag`,
    [auth.tenantId]
  );
  return result.rows.map((r) => r.tag);
});

app.get("/api/v1/alert-templates/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  const templateResult = await pool.query(
    `SELECT t.id, t.name, t.device_type, t.created_at, t.tags, t.parent_template_id,
            pt.name as parent_template_name
     FROM alert_templates t
     LEFT JOIN alert_templates pt ON pt.id = t.parent_template_id
     WHERE t.tenant_id = $1 AND t.id = $2`,
    [auth.tenantId, id]
  );
  if (templateResult.rows.length === 0) return reply.status(404).send({ error: "Şablon bulunamadı" });

  const rulesResult = await pool.query(
    `SELECT r.id, r.metric_name, r.condition, r.threshold, r.duration_seconds, r.severity,
            r.depends_on_template_rule_id, dr.metric_name as depends_on_metric_name
     FROM alert_template_rules r
     LEFT JOIN alert_template_rules dr ON dr.id = r.depends_on_template_rule_id
     WHERE r.template_id = $1 ORDER BY r.metric_name`,
    [id]
  );

  const childrenResult = await pool.query(
    `SELECT id, name FROM alert_templates WHERE parent_template_id = $1`,
    [id]
  );

  return { ...templateResult.rows[0], rules: rulesResult.rows, children: childrenResult.rows };
});

app.post("/api/v1/alert-templates", async (request, reply) => {
  const auth = (request as any).auth;
  const parsed = CreateTemplateSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { name, device_type, tags, parent_template_id, rules } = parsed.data;

  if (parent_template_id && !(await idBelongsToTenant("alert_templates", parent_template_id, auth.tenantId))) {
    return reply.status(404).send({ error: "Üst şablon bulunamadı" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const templateResult = await client.query(
      `INSERT INTO alert_templates (tenant_id, name, device_type, tags, parent_template_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [auth.tenantId, name, device_type || null, JSON.stringify(tags || []), parent_template_id || null]
    );
    const templateId = templateResult.rows[0].id;

    const insertedRuleIds: string[] = [];
    for (const rule of rules) {
      const ruleResult = await client.query(
        `INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity, threshold_macro_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [templateId, rule.metric_name, rule.condition, rule.threshold ?? 0, rule.duration_seconds, rule.severity, rule.threshold_macro_key || null]
      );
      insertedRuleIds.push(ruleResult.rows[0].id);
    }
    // İkinci geçiş: depends_on_index'leri gerçek UUID referanslarına çevir
    for (let i = 0; i < rules.length; i++) {
      const depIndex = rules[i].depends_on_index;
      if (depIndex !== null && depIndex !== undefined && insertedRuleIds[depIndex]) {
        await client.query(
          `UPDATE alert_template_rules SET depends_on_template_rule_id = $1 WHERE id = $2`,
          [insertedRuleIds[depIndex], insertedRuleIds[i]]
        );
      }
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

  // Template'in gerçekten bu tenant'a ait olduğunu doğrula (cross-tenant erişimi engeller)
  const templateCheck = await pool.query(
    `SELECT id FROM alert_templates WHERE id = $1 AND tenant_id = $2`,
    [id, auth.tenantId]
  );
  if (templateCheck.rows.length === 0) return reply.status(404).send({ error: "Şablon bulunamadı" });

  const rulesResult = await pool.query(
    `SELECT id, metric_name, condition, threshold, duration_seconds, severity, depends_on_template_rule_id, threshold_macro_key
     FROM alert_template_rules WHERE template_id = $1`,
    [id]
  );
  if (rulesResult.rows.length === 0) return reply.status(404).send({ error: "Şablonda kural yok" });

  // device_group'un da bu tenant'a ait olduğunu doğrula
  const groupCheck = await pool.query(
    `SELECT id FROM device_groups WHERE id = $1 AND tenant_id = $2`,
    [parsed.data.device_group_id, auth.tenantId]
  );
  if (groupCheck.rows.length === 0) return reply.status(404).send({ error: "Host grubu bulunamadı" });

  const membersResult = await pool.query(
    `SELECT device_id FROM device_group_members WHERE device_group_id = $1`,
    [parsed.data.device_group_id]
  );
  const deviceIds = membersResult.rows.map((r) => r.device_id);

  let created = 0;
  for (const deviceId of deviceIds) {
    // Bu cihaz için template_rule_id -> yeni oluşturulan alert_rule.id eşlemesi
    const templateRuleIdToNewRuleId = new Map<string, string>();

    for (const rule of rulesResult.rows) {
      let effectiveThreshold = Number(rule.threshold);
      if (rule.threshold_macro_key) {
        const resolved = await resolveMacroValue(rule.threshold_macro_key, auth.tenantId, deviceId);
        if (resolved !== null) effectiveThreshold = resolved;
      }

      // Idempotent: aynı (device_id, template_rule_id) çifti zaten varsa, yeni satır eklemek
      // yerine mevcut kuralı GÜNCELLER — hem tekrar-uygulamada çoğalmayı önler, hem de
      // template'te sonradan yapılan değişikliklerin mevcut cihazlara yansımasını sağlar.
      const inserted = await pool.query(
        `INSERT INTO alert_rules (tenant_id, source_module, metric_name, condition, threshold, duration_seconds, device_id, severity, template_rule_id)
         VALUES ($1, 'npm', $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (device_id, template_rule_id) WHERE template_rule_id IS NOT NULL
         DO UPDATE SET condition = EXCLUDED.condition, threshold = EXCLUDED.threshold,
                        duration_seconds = EXCLUDED.duration_seconds, severity = EXCLUDED.severity
         RETURNING id`,
        [auth.tenantId, rule.metric_name, rule.condition, effectiveThreshold, rule.duration_seconds, deviceId, rule.severity, rule.id]
      );
      templateRuleIdToNewRuleId.set(rule.id, inserted.rows[0].id);
      created++;
    }

    // İkinci geçiş: template'teki bağımlılıkları, bu cihaz için oluşturulan gerçek kural ID'lerine aktar
    for (const rule of rulesResult.rows) {
      if (rule.depends_on_template_rule_id) {
        const thisRuleId = templateRuleIdToNewRuleId.get(rule.id);
        const dependsOnRuleId = templateRuleIdToNewRuleId.get(rule.depends_on_template_rule_id);
        if (thisRuleId && dependsOnRuleId) {
          await pool.query(
            `INSERT INTO alert_rule_dependencies (rule_id, depends_on_rule_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [thisRuleId, dependsOnRuleId]
          );
        }
      }
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

  if (!(await idBelongsToTenant("media_types", media_type_id, auth.tenantId))) {
    return reply.status(404).send({ error: "Bildirim kanalı bulunamadı" });
  }
  if (device_group_id && !(await idBelongsToTenant("device_groups", device_group_id, auth.tenantId))) {
    return reply.status(404).send({ error: "Grup bulunamadı" });
  }

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
  oid: z.string().optional(),
  data_type: z.enum(["gauge", "counter", "string"]).default("gauge"),
  unit: z.string().optional(),
  polling_interval_seconds: z.number().min(10).default(60),
  is_table: z.boolean().default(false),
  formula: z.string().optional(),
  formula_oids: z.record(z.string()).optional()
}).refine((data) => data.oid || (data.formula && data.formula_oids), {
  message: "Ya 'oid' ya da 'formula'+'formula_oids' gerekli"
});

app.get("/api/v1/alert-templates/:id/items", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("alert_templates", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Şablon bulunamadı" });
  }
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
  if (!(await idBelongsToTenant("alert_templates", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Şablon bulunamadı" });
  }
  const parsed = CreateItemSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const { metric_name, oid, data_type, unit, polling_interval_seconds, is_table, formula, formula_oids } = parsed.data;
  const result = await pool.query(
    `INSERT INTO template_items (template_id, metric_name, oid, data_type, unit, polling_interval_seconds, is_table, formula, formula_oids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, metric_name, oid, data_type, unit, polling_interval_seconds, is_table, formula, formula_oids`,
    [id, metric_name, oid || null, data_type, unit || null, polling_interval_seconds, is_table, formula || null, formula_oids ? JSON.stringify(formula_oids) : null]
  );
  return reply.status(201).send(result.rows[0]);
});

app.delete("/api/v1/template-items/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const result = await pool.query(
    `DELETE FROM template_items ti USING alert_templates t
     WHERE ti.id = $1 AND ti.template_id = t.id AND t.tenant_id = $2
     RETURNING ti.id`,
    [id, auth.tenantId]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Item bulunamadı" });
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

  const deviceCheck = await pool.query(`SELECT id FROM devices WHERE id = $1 AND tenant_id = $2`, [id, auth.tenantId]);
  if (deviceCheck.rows.length === 0) return reply.status(404).send({ error: "Cihaz bulunamadı" });

  const templateCheck = await pool.query(`SELECT id FROM alert_templates WHERE id = $1 AND tenant_id = $2`, [parsed.data.template_id, auth.tenantId]);
  if (templateCheck.rows.length === 0) return reply.status(404).send({ error: "Şablon bulunamadı" });

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
app.get("/api/v1/devices/:id/effective-items", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("devices", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Cihaz bulunamadı" });
  }

  // Cihaza atanmış doğrudan template'ler + TÜM ebeveyn zinciri (recursive CTE ile,
  // A→B→C gibi çok seviyeli miras artık tam destekleniyor, tek seviyeyle sınırlı değil)
  const directTemplates = await pool.query(
    `SELECT template_id FROM device_templates WHERE device_id = $1`,
    [id]
  );

  if (directTemplates.rows.length === 0) return [];

  const directIds = directTemplates.rows.map((r) => r.template_id);

  const chainResult = await pool.query(
    `WITH RECURSIVE template_chain AS (
       SELECT id, parent_template_id FROM alert_templates WHERE id = ANY($1::uuid[])
       UNION ALL
       SELECT t.id, t.parent_template_id
       FROM alert_templates t
       JOIN template_chain tc ON t.id = tc.parent_template_id
     )
     SELECT DISTINCT id FROM template_chain`,
    [directIds]
  );

  const templateIds = new Set<string>(chainResult.rows.map((r) => r.id));
  if (templateIds.size === 0) return [];

  const itemsResult = await pool.query(
    `SELECT DISTINCT metric_name, oid, data_type, unit, polling_interval_seconds, is_table, formula, formula_oids
     FROM template_items WHERE template_id = ANY($1::uuid[])`,
    [Array.from(templateIds)]
  );
  return itemsResult.rows;
});


// ============ RELATIONS (çapraz bağlantı verileri — dashboard "İlişkiler" panelleri için) ============

// Bir cihazda sorun çıktığında "nereden kaynaklanıyor" sorusuna tek ekranda cevap:
// 1) bu cihazın son alarmları, 2) bu cihaza dair son yapılandırma değişiklikleri,
// 3) topolojide bağlı komşu cihazlarda da alarm var mı (varsa ve daha ÖNCE başladıysa
//    "olası kök neden" olarak işaretlenir — SolarWinds'in topology-aware dependency
//    mantığının basitleştirilmiş hâli), 4) aynı zaman aralığında başka cihazlarda da
//    alarm tetiklendi mi (izole bir olay mı, yoksa daha geniş bir kesinti mi).
app.get("/api/v1/devices/:id/diagnostics", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  const deviceCheck = await pool.query(`SELECT id, name FROM devices WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  if (deviceCheck.rows.length === 0) return reply.status(404).send({ error: "Cihaz bulunamadı" });

  // 1) Son 48 saatteki tüm alarmlar (açık + çözülmüş)
  const recentAlertsResult = await pool.query(
    `SELECT id, metric_name, condition, threshold, value, severity, message, triggered_at, resolved_at, acknowledged_at
     FROM alerts
     WHERE tenant_id = $1 AND device_id = $2 AND triggered_at >= now() - interval '48 hours'
     ORDER BY triggered_at DESC`,
    [auth.tenantId, id]
  );

  // 2) Bu cihaza dair son yapılandırma değişiklikleri (audit log'da yolu bu cihazın
  // ID'sini içeren kayıtlar — cihazın kendisi, şablon ataması, ad-hoc kuralları vb.)
  const recentChangesResult = await pool.query(
    `SELECT id, user_email, method, path, status_code, created_at
     FROM audit_log
     WHERE tenant_id = $1 AND path LIKE $2
     ORDER BY created_at DESC LIMIT 20`,
    [auth.tenantId, `%${id}%`]
  );

  // Bu cihazın şu an açık en eski alarmı — "olay ne zaman başladı" referans noktası.
  // Diğer cihazlardaki alarmlarla zamansal karşılaştırma bunun üzerinden yapılır.
  const anchorResult = await pool.query(
    `SELECT MIN(triggered_at) as anchor FROM alerts WHERE tenant_id = $1 AND device_id = $2 AND resolved_at IS NULL`,
    [auth.tenantId, id]
  );
  const anchorTime: string | null = anchorResult.rows[0]?.anchor ?? null;

  // 3) Topolojide bağlı komşu cihazlar + onlardaki en eski açık alarm.
  // Komşunun alarmı bizimkinden ÖNCE başladıysa, muhtemel kök neden odur
  // (SolarWinds'in "upstream cihaz çökerse downstream'i onun sonucu say" mantığı).
  const neighborsResult = await pool.query(
    `SELECT d.id, d.name,
            oldest_alert.message as open_alert_message,
            oldest_alert.triggered_at as open_alert_triggered_at,
            oldest_alert.severity as open_alert_severity
     FROM device_links dl
     JOIN devices d ON d.id = (CASE WHEN dl.device_a_id = $2 THEN dl.device_b_id ELSE dl.device_a_id END)
     LEFT JOIN LATERAL (
       SELECT message, triggered_at, severity FROM alerts
       WHERE device_id = d.id AND resolved_at IS NULL
       ORDER BY triggered_at ASC LIMIT 1
     ) oldest_alert ON true
     WHERE dl.tenant_id = $1 AND (dl.device_a_id = $2 OR dl.device_b_id = $2)`,
    [auth.tenantId, id]
  );
  const topologyNeighbors = neighborsResult.rows.map((n) => ({
    id: n.id,
    name: n.name,
    open_alert_message: n.open_alert_message,
    open_alert_triggered_at: n.open_alert_triggered_at,
    open_alert_severity: n.open_alert_severity,
    likely_root_cause: !!(n.open_alert_triggered_at && anchorTime && new Date(n.open_alert_triggered_at) <= new Date(anchorTime))
  }));

  // 4) Aynı ±15 dakikalık pencerede başka cihazlarda da alarm var mı (izole olay mı,
  // geniş bir kesinti mi ayırt etmek için) — sadece bizim bir açık alarmımız varsa anlamlı.
  let concurrentIncidents: any[] = [];
  if (anchorTime) {
    const concurrentResult = await pool.query(
      `SELECT a.id, a.device_id, d.name as device_name, a.message, a.severity, a.triggered_at
       FROM alerts a JOIN devices d ON d.id = a.device_id
       WHERE a.tenant_id = $1 AND a.device_id != $2 AND a.resolved_at IS NULL
         AND a.triggered_at BETWEEN $3::timestamptz - interval '15 minutes' AND $3::timestamptz + interval '15 minutes'
       ORDER BY a.triggered_at ASC LIMIT 20`,
      [auth.tenantId, id, anchorTime]
    );
    concurrentIncidents = concurrentResult.rows;
  }

  return {
    recent_alerts: recentAlertsResult.rows,
    recent_changes: recentChangesResult.rows,
    topology_neighbors: topologyNeighbors,
    concurrent_incidents: concurrentIncidents,
    anchor_time: anchorTime
  };
});

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
            (r.template_rule_id IS NOT NULL) as from_template,
            dep_rule.metric_name as depends_on_metric_name
     FROM alert_rules r
     LEFT JOIN alert_rule_dependencies ard ON ard.rule_id = r.id
     LEFT JOIN alert_rules dep_rule ON dep_rule.id = ard.depends_on_rule_id
     WHERE r.device_id = $1 ORDER BY r.metric_name`,
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

  const maintenanceResult = await pool.query(
    `SELECT mw.id, mw.name, mw.starts_at, mw.ends_at
     FROM maintenance_windows mw
     WHERE mw.tenant_id = $1
       AND mw.starts_at <= now() AND mw.ends_at >= now()
       AND (
         EXISTS (SELECT 1 FROM maintenance_window_devices mwd WHERE mwd.maintenance_window_id = mw.id AND mwd.device_id = $2)
         OR EXISTS (
           SELECT 1 FROM maintenance_window_groups mwg
           JOIN device_group_members dgm ON dgm.device_group_id = mwg.device_group_id
           WHERE mwg.maintenance_window_id = mw.id AND dgm.device_id = $2
         )
       )`,
    [auth.tenantId, id]
  );

  return {
    device_groups: groupsResult.rows,
    templates: templatesResult.rows,
    alert_rules: rulesResult.rows,
    notification_targets: notificationsResult.rows,
    active_maintenance: maintenanceResult.rows
  };
});

// Host Group detayına uygulanan template geçmişi
app.get("/api/v1/device-groups/:id/applied-templates", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("device_groups", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Grup bulunamadı" });
  }
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
     WHERE t.tenant_id = $2
       AND r.device_id IN (SELECT device_id FROM device_group_members WHERE device_group_id = $1)`,
    [id, auth.tenantId]
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


// ============ ALERT RULE DEPENDENCIES ============

const SetDependencySchema = z.object({ depends_on_rule_id: z.string().uuid() });

app.post("/api/v1/alert-rules/:id/dependencies", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  const parsed = SetDependencySchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  if (!(await idsBelongToTenant("alert_rules", [id, parsed.data.depends_on_rule_id], auth.tenantId))) {
    return reply.status(404).send({ error: "Kurallardan biri veya ikisi de bulunamadı" });
  }

  await pool.query(
    `INSERT INTO alert_rule_dependencies (rule_id, depends_on_rule_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [id, parsed.data.depends_on_rule_id]
  );
  return reply.status(201).send({ rule_id: id, depends_on_rule_id: parsed.data.depends_on_rule_id });
});

app.delete("/api/v1/alert-rules/:id/dependencies/:dependsOnId", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id, dependsOnId } = request.params as { id: string; dependsOnId: string };
  if (!(await idBelongsToTenant("alert_rules", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Kural bulunamadı" });
  }
  await pool.query(`DELETE FROM alert_rule_dependencies WHERE rule_id = $1 AND depends_on_rule_id = $2`, [id, dependsOnId]);
  return reply.status(204).send();
});

app.get("/api/v1/alert-rules/:id/dependencies", async (request) => {
  const { id } = request.params as { id: string };
  const result = await pool.query(
    `SELECT d.depends_on_rule_id, r.metric_name, r.condition, r.threshold
     FROM alert_rule_dependencies d
     JOIN alert_rules r ON r.id = d.depends_on_rule_id
     WHERE d.rule_id = $1`,
    [id]
  );
  return result.rows;
});


// Bağımlılık nedeniyle bastırılan alarmlar — kullanıcının "neden alarm gelmedi"
// sorusuna şeffaf bir cevap verir.
app.get("/api/v1/suppressed-alerts", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT sa.id, sa.message, sa.suppressed_at,
            d.name as device_name, d.id as device_id,
            r.metric_name as suppressed_metric,
            dr.metric_name as suppressing_metric
     FROM suppressed_alerts sa
     JOIN devices d ON d.id = sa.device_id
     JOIN alert_rules r ON r.id = sa.rule_id
     JOIN alert_rules dr ON dr.id = sa.depends_on_rule_id
     WHERE sa.tenant_id = $1
     ORDER BY sa.suppressed_at DESC
     LIMIT 100`,
    [auth.tenantId]
  );
  return result.rows;
});


// Bir cihazın tüm kuralları (şablondan gelen + ad-hoc) — cihaz bazlı yönetim için
app.get("/api/v1/devices/:id/alert-rules", async (request) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  const result = await pool.query(
    `SELECT id, metric_name, condition, threshold, duration_seconds, severity, active,
            (template_rule_id IS NOT NULL) as from_template
     FROM alert_rules WHERE tenant_id = $1 AND device_id = $2 ORDER BY metric_name`,
    [auth.tenantId, id]
  );
  return result.rows;
});

// Cihaza özel (ad-hoc, şablonsuz) kural oluşturma
const CreateDeviceRuleSchema = z.object({
  metric_name: z.string().min(1),
  condition: z.enum(["gt", "lt", "eq"]),
  threshold: z.number(),
  duration_seconds: z.number().min(30).default(60),
  severity: z.enum(["info", "warning", "average", "high", "disaster"]).default("warning")
});

app.post("/api/v1/devices/:id/alert-rules", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  const parsed = CreateDeviceRuleSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { metric_name, condition, threshold, duration_seconds, severity } = parsed.data;

  if (!(await idBelongsToTenant("devices", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Cihaz bulunamadı" });
  }

  const result = await pool.query(
    `INSERT INTO alert_rules (tenant_id, source_module, metric_name, condition, threshold, duration_seconds, device_id, severity)
     VALUES ($1, 'npm', $2, $3, $4, $5, $6, $7)
     RETURNING id, metric_name, condition, threshold, duration_seconds, severity, active`,
    [auth.tenantId, metric_name, condition, threshold, duration_seconds, id, severity]
  );
  return reply.status(201).send({ ...result.rows[0], from_template: false });
});


// Birden fazla cihazı tek seferde bir host grubuna ekle
const BulkAddToGroupSchema = z.object({ device_ids: z.array(z.string().uuid()), device_group_id: z.string().uuid() });

app.post("/api/v1/devices/bulk-assign-group", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditDevices) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const parsed = BulkAddToGroupSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const groupCheck = await pool.query(`SELECT id FROM device_groups WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, parsed.data.device_group_id]);
  if (groupCheck.rows.length === 0) return reply.status(404).send({ error: "Grup bulunamadı" });

  const ownedDevices = await pool.query(
    `SELECT id FROM devices WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
    [parsed.data.device_ids, auth.tenantId]
  );

  for (const row of ownedDevices.rows) {
    await pool.query(
      `INSERT INTO device_group_members (device_group_id, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [parsed.data.device_group_id, row.id]
    );
  }
  return { added: ownedDevices.rows.length };
});

// Birden fazla cihaza tek seferde bir şablon ata
const BulkAssignTemplateSchema = z.object({ device_ids: z.array(z.string().uuid()), template_id: z.string().uuid() });

app.post("/api/v1/devices/bulk-assign-template", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditDevices) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const parsed = BulkAssignTemplateSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const templateCheck = await pool.query(`SELECT id FROM alert_templates WHERE id = $1 AND tenant_id = $2`, [parsed.data.template_id, auth.tenantId]);
  if (templateCheck.rows.length === 0) return reply.status(404).send({ error: "Şablon bulunamadı" });

  // Sadece gerçekten bu tenant'a ait cihazları işle — listede başka tenant'ın ID'si varsa sessizce atlanır
  const ownedDevices = await pool.query(
    `SELECT id FROM devices WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
    [parsed.data.device_ids, auth.tenantId]
  );

  for (const row of ownedDevices.rows) {
    await pool.query(
      `INSERT INTO device_templates (device_id, template_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [row.id, parsed.data.template_id]
    );
  }
  return { assigned: ownedDevices.rows.length };
});


// ============ MACROS ============

const CreateMacroSchema = z.object({
  key: z.string().regex(/^\{\$[A-Z0-9_]+\}$/, "Format: {$ISIM_BUYUK_HARF}"),
  default_value: z.number(),
  description: z.string().optional()
});

app.get("/api/v1/macros", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT id, key, default_value, description FROM macros WHERE tenant_id = $1 ORDER BY key`,
    [auth.tenantId]
  );
  return result.rows;
});

app.post("/api/v1/macros", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const parsed = CreateMacroSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  try {
    const result = await pool.query(
      `INSERT INTO macros (tenant_id, key, default_value, description) VALUES ($1, $2, $3, $4)
       RETURNING id, key, default_value, description`,
      [auth.tenantId, parsed.data.key, parsed.data.default_value, parsed.data.description || null]
    );
    return reply.status(201).send(result.rows[0]);
  } catch (err: any) {
    if (err.code === "23505") return reply.status(409).send({ error: "Bu makro anahtarı zaten var" });
    throw err;
  }
});

app.delete("/api/v1/macros/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM macros WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});

// Bir makronun device/device_group bazlı override'ları
const SetMacroOverrideSchema = z.object({
  scope_type: z.enum(["device", "device_group"]),
  scope_id: z.string().uuid(),
  value: z.number()
});

app.get("/api/v1/macros/:id/overrides", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  const macroCheck = await pool.query(`SELECT id FROM macros WHERE id = $1 AND tenant_id = $2`, [id, auth.tenantId]);
  if (macroCheck.rows.length === 0) return reply.status(404).send({ error: "Makro bulunamadı" });

  const result = await pool.query(
    `SELECT mo.id, mo.scope_type, mo.scope_id, mo.value,
            COALESCE(d.name, g.name) as scope_name
     FROM macro_overrides mo
     LEFT JOIN devices d ON d.id = mo.scope_id AND mo.scope_type = 'device'
     LEFT JOIN device_groups g ON g.id = mo.scope_id AND mo.scope_type = 'device_group'
     WHERE mo.macro_id = $1`,
    [id]
  );
  return result.rows;
});

app.post("/api/v1/macros/:id/overrides", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  const parsed = SetMacroOverrideSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const macroCheck = await pool.query(`SELECT id FROM macros WHERE id = $1 AND tenant_id = $2`, [id, auth.tenantId]);
  if (macroCheck.rows.length === 0) return reply.status(404).send({ error: "Makro bulunamadı" });

  // scope_id'nin de gerçekten bu tenant'a ait olduğunu doğrula
  const scopeTable = parsed.data.scope_type === "device" ? "devices" : "device_groups";
  const scopeCheck = await pool.query(`SELECT id FROM ${scopeTable} WHERE id = $1 AND tenant_id = $2`, [parsed.data.scope_id, auth.tenantId]);
  if (scopeCheck.rows.length === 0) return reply.status(404).send({ error: "Hedef cihaz/grup bulunamadı" });

  const result = await pool.query(
    `INSERT INTO macro_overrides (macro_id, scope_type, scope_id, value) VALUES ($1, $2, $3, $4)
     ON CONFLICT (macro_id, scope_type, scope_id) DO UPDATE SET value = $4
     RETURNING id, scope_type, scope_id, value`,
    [id, parsed.data.scope_type, parsed.data.scope_id, parsed.data.value]
  );
  return reply.status(201).send(result.rows[0]);
});

app.delete("/api/v1/macros/:id/overrides/:overrideId", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id, overrideId } = request.params as { id: string; overrideId: string };

  const result = await pool.query(
    `DELETE FROM macro_overrides mo USING macros m
     WHERE mo.id = $1 AND mo.macro_id = $2 AND mo.macro_id = m.id AND m.tenant_id = $3
     RETURNING mo.id`,
    [overrideId, id, auth.tenantId]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Override bulunamadı" });
  return reply.status(204).send();
});

// Bir cihaz için makro değerini öncelik sırasına göre çöz:
// device override > device_group override > macro varsayılanı
async function resolveMacroValue(macroKey: string, tenantId: string, deviceId: string): Promise<number | null> {
  const macroResult = await pool.query(`SELECT id, default_value FROM macros WHERE tenant_id = $1 AND key = $2`, [tenantId, macroKey]);
  if (macroResult.rows.length === 0) return null;
  const macro = macroResult.rows[0];

  const deviceOverride = await pool.query(
    `SELECT value FROM macro_overrides WHERE macro_id = $1 AND scope_type = 'device' AND scope_id = $2`,
    [macro.id, deviceId]
  );
  if (deviceOverride.rows.length > 0) return Number(deviceOverride.rows[0].value);

  // Cihaz birden fazla gruba üyeyse ve her ikisi de aynı makroyu override ediyorsa,
  // belirsizliği önlemek için en son oluşturulan grubun override'ı kazanır (deterministik).
  const groupOverride = await pool.query(
    `SELECT mo.value FROM macro_overrides mo
     JOIN device_group_members dgm ON dgm.device_group_id = mo.scope_id
     JOIN device_groups dg ON dg.id = mo.scope_id
     WHERE mo.macro_id = $1 AND mo.scope_type = 'device_group' AND dgm.device_id = $2
     ORDER BY dg.created_at DESC
     LIMIT 1`,
    [macro.id, deviceId]
  );
  if (groupOverride.rows.length > 0) return Number(groupOverride.rows[0].value);

  return Number(macro.default_value);
}


// ============ MAINTENANCE WINDOWS ============

const CreateMaintenanceSchema = z.object({
  name: z.string().min(1),
  starts_at: z.string(),
  ends_at: z.string(),
  device_ids: z.array(z.string().uuid()).optional(),
  device_group_ids: z.array(z.string().uuid()).optional()
});

app.get("/api/v1/maintenance-windows", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT mw.id, mw.name, mw.starts_at, mw.ends_at, mw.created_at,
            (mw.starts_at <= now() AND mw.ends_at >= now()) as is_active,
            COUNT(DISTINCT mwd.device_id)::int as device_count,
            COUNT(DISTINCT mwg.device_group_id)::int as group_count
     FROM maintenance_windows mw
     LEFT JOIN maintenance_window_devices mwd ON mwd.maintenance_window_id = mw.id
     LEFT JOIN maintenance_window_groups mwg ON mwg.maintenance_window_id = mw.id
     WHERE mw.tenant_id = $1
     GROUP BY mw.id
     ORDER BY mw.starts_at DESC`,
    [auth.tenantId]
  );
  return result.rows;
});

app.get("/api/v1/maintenance-windows/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  const mwResult = await pool.query(
    `SELECT id, name, starts_at, ends_at, (starts_at <= now() AND ends_at >= now()) as is_active
     FROM maintenance_windows WHERE tenant_id = $1 AND id = $2`,
    [auth.tenantId, id]
  );
  if (mwResult.rows.length === 0) return reply.status(404).send({ error: "Bakım penceresi bulunamadı" });

  const devicesResult = await pool.query(
    `SELECT d.id, d.name FROM maintenance_window_devices mwd JOIN devices d ON d.id = mwd.device_id WHERE mwd.maintenance_window_id = $1`,
    [id]
  );
  const groupsResult = await pool.query(
    `SELECT g.id, g.name FROM maintenance_window_groups mwg JOIN device_groups g ON g.id = mwg.device_group_id WHERE mwg.maintenance_window_id = $1`,
    [id]
  );

  return { ...mwResult.rows[0], devices: devicesResult.rows, groups: groupsResult.rows };
});

app.post("/api/v1/maintenance-windows", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditDevices) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const parsed = CreateMaintenanceSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { name, starts_at, ends_at, device_ids, device_group_ids } = parsed.data;

  if (!(await idsBelongToTenant("devices", device_ids || [], auth.tenantId))) {
    return reply.status(404).send({ error: "Cihazlardan biri veya birkaçı bulunamadı" });
  }
  if (!(await idsBelongToTenant("device_groups", device_group_ids || [], auth.tenantId))) {
    return reply.status(404).send({ error: "Gruplardan biri veya birkaçı bulunamadı" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const mwResult = await client.query(
      `INSERT INTO maintenance_windows (tenant_id, name, starts_at, ends_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [auth.tenantId, name, starts_at, ends_at]
    );
    const mwId = mwResult.rows[0].id;

    for (const deviceId of device_ids || []) {
      await client.query(`INSERT INTO maintenance_window_devices (maintenance_window_id, device_id) VALUES ($1, $2)`, [mwId, deviceId]);
    }
    for (const groupId of device_group_ids || []) {
      await client.query(`INSERT INTO maintenance_window_groups (maintenance_window_id, device_group_id) VALUES ($1, $2)`, [mwId, groupId]);
    }

    await client.query("COMMIT");
    return reply.status(201).send({ id: mwId, name, starts_at, ends_at });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

app.delete("/api/v1/maintenance-windows/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditDevices) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM maintenance_windows WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});


app.get("/api/v1/audit-log", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canManageUsers) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const query = request.query as { user_email?: string; method?: string; limit?: string; page?: string };

  const conditions: string[] = ["tenant_id = $1"];
  const params: any[] = [auth.tenantId];
  let paramIndex = 2;

  if (query.user_email) {
    conditions.push(`user_email = $${paramIndex}`);
    params.push(query.user_email);
    paramIndex++;
  }
  if (query.method) {
    conditions.push(`method = $${paramIndex}`);
    params.push(query.method);
    paramIndex++;
  }

  const limit = Math.min(Number(query.limit) || 50, 200);
  const page = Math.max(Number(query.page) || 1, 1);
  const offset = (page - 1) * limit;

  const result = await pool.query(
    `SELECT id, user_email, method, path, status_code, request_body, response_body, created_at,
            COUNT(*) OVER()::int as total_count
     FROM audit_log WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  const total = result.rows[0]?.total_count ?? 0;
  const items = result.rows.map(({ total_count, ...rest }) => rest);

  return { items, total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) };
});


// Template'in kendisini güncelle (isim, tags, parent, device_type)
const UpdateTemplateSchema = z.object({
  name: z.string().min(1).optional(),
  device_type: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  parent_template_id: z.string().uuid().nullable().optional()
});

app.patch("/api/v1/alert-templates/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  const parsed = UpdateTemplateSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { name, device_type, tags, parent_template_id } = parsed.data;

  const result = await pool.query(
    `UPDATE alert_templates SET
       name = COALESCE($3, name),
       device_type = COALESCE($4, device_type),
       tags = COALESCE($5, tags),
       parent_template_id = $6
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, name, device_type, tags, parent_template_id`,
    [auth.tenantId, id, name, device_type, tags ? JSON.stringify(tags) : null, parent_template_id]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Şablon bulunamadı" });
  return result.rows[0];
});

// Bir template kuralını güncelle
const UpdateTemplateRuleSchema = z.object({
  condition: z.enum(["gt", "lt", "eq"]).optional(),
  threshold: z.number().optional(),
  threshold_macro_key: z.string().nullable().optional(),
  duration_seconds: z.number().min(30).optional(),
  severity: z.enum(["info", "warning", "average", "high", "disaster"]).optional(),
  depends_on_template_rule_id: z.string().uuid().nullable().optional()
});

app.patch("/api/v1/alert-template-rules/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  const parsed = UpdateTemplateRuleSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { condition, threshold, threshold_macro_key, duration_seconds, severity, depends_on_template_rule_id } = parsed.data;

  const result = await pool.query(
    `UPDATE alert_template_rules SET
       condition = COALESCE($2, condition),
       threshold = COALESCE($3, threshold),
       threshold_macro_key = $4,
       duration_seconds = COALESCE($5, duration_seconds),
       severity = COALESCE($6, severity),
       depends_on_template_rule_id = $7
     WHERE id = $1
     RETURNING id, metric_name, condition, threshold, duration_seconds, severity, threshold_macro_key, depends_on_template_rule_id`,
    [id, condition, threshold, threshold_macro_key, duration_seconds, severity, depends_on_template_rule_id]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Kural bulunamadı" });
  return result.rows[0];
});

app.delete("/api/v1/alert-template-rules/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM alert_template_rules WHERE id = $1`, [id]);
  return reply.status(204).send();
});

// Yeni kural ekle (mevcut template'e, oluşturma dışında)
const AddTemplateRuleSchema = z.object({
  metric_name: z.string().min(1),
  condition: z.enum(["gt", "lt", "eq"]),
  threshold: z.number().optional(),
  threshold_macro_key: z.string().optional(),
  duration_seconds: z.number().min(30).default(60),
  severity: z.enum(["info", "warning", "average", "high", "disaster"]).default("warning")
});

app.post("/api/v1/alert-templates/:id/rules", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  const parsed = AddTemplateRuleSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { metric_name, condition, threshold, threshold_macro_key, duration_seconds, severity } = parsed.data;

  const result = await pool.query(
    `INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity, threshold_macro_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, metric_name, condition, threshold, duration_seconds, severity`,
    [id, metric_name, condition, threshold ?? 0, duration_seconds, severity, threshold_macro_key || null]
  );
  return reply.status(201).send(result.rows[0]);
});

// Bir template item'ını güncelle
const UpdateTemplateItemSchema = z.object({
  metric_name: z.string().min(1).optional(),
  oid: z.string().nullable().optional(),
  data_type: z.enum(["gauge", "counter", "string"]).optional(),
  unit: z.string().nullable().optional(),
  polling_interval_seconds: z.number().min(10).optional(),
  formula: z.string().nullable().optional(),
  formula_oids: z.record(z.string()).nullable().optional()
});

app.patch("/api/v1/template-items/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  const parsed = UpdateTemplateItemSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { metric_name, oid, data_type, unit, polling_interval_seconds, formula, formula_oids } = parsed.data;

  const result = await pool.query(
    `UPDATE template_items SET
       metric_name = COALESCE($2, metric_name),
       oid = $3,
       data_type = COALESCE($4, data_type),
       unit = $5,
       polling_interval_seconds = COALESCE($6, polling_interval_seconds),
       formula = $7,
       formula_oids = $8
     WHERE id = $1
     RETURNING id, metric_name, oid, data_type, unit, polling_interval_seconds, formula, formula_oids`,
    [id, metric_name, oid, data_type, unit, polling_interval_seconds, formula, formula_oids ? JSON.stringify(formula_oids) : null]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Item bulunamadı" });
  return result.rows[0];
});


// Bu şablonun uygulandığı host gruplarının listesi (tersinden bakış — device_groups/applied-templates'in aynası)
app.get("/api/v1/alert-templates/:id/groups", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  const templateCheck = await pool.query(`SELECT id FROM alert_templates WHERE id = $1 AND tenant_id = $2`, [id, auth.tenantId]);
  if (templateCheck.rows.length === 0) return reply.status(404).send({ error: "Şablon bulunamadı" });

  const result = await pool.query(
    `SELECT DISTINCT dg.id, dg.name,
            COUNT(DISTINCT dgm.device_id)::int as device_count
     FROM device_groups dg
     JOIN device_group_members dgm ON dgm.device_group_id = dg.id
     JOIN alert_rules ar ON ar.device_id = dgm.device_id
     JOIN alert_template_rules atr ON atr.id = ar.template_rule_id
     WHERE atr.template_id = $1 AND dg.tenant_id = $2
     GROUP BY dg.id`,
    [id, auth.tenantId]
  );
  return result.rows;
});

const port = Number(process.env.PORT) || 3000;
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
