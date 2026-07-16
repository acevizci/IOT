import Fastify from "fastify";
import zlib from "zlib";
import crypto from "crypto";
import { z } from "zod";
import { encryptSecret, decryptSecret } from "./crypto.js";
import { generateRegistrationToken, hashRegistrationToken, generateDevicePsk, hashDevicePsk } from "./agentAuth.js";
import { publishAgentMetric } from "./redisClient.js";
import { generateApiToken, hashApiToken } from "./apiTokens.js";
import bcrypt from "bcryptjs";
import { pool, checkDbConnection, queryClickHouse } from "./db.js";
import { signToken } from "./auth.js";

const app = Fastify({ logger: true });

// Faz E — Go Agent, metrik payload'ını gzip ile sıkıştırıp application/octet-stream
// olarak gönderiyor (application/json ile göndermek, Gateway'in kendi body parser'ının
// gzip'li ham byte'ları JSON olarak parse etmeye çalışıp bozmasına yol açıyordu). Burada
// bu content-type'ı manuel olarak gunzip edip JSON'a çeviriyoruz — SADECE Content-Encoding
// gzip ise; aksi halde ham body olduğu gibi bırakılır (ileride başka amaçlarla kullanılabilir).
app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (request, body, done) => {
  try {
    const isGzip = request.headers["content-encoding"] === "gzip";
    const decompressed = isGzip ? zlib.gunzipSync(body as Buffer) : (body as Buffer);
    const json = JSON.parse(decompressed.toString("utf-8"));
    done(null, json);
  } catch (err) {
    done(err as Error, undefined);
  }
});

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
    `SELECT u.id, u.tenant_id, u.email, u.password_hash, u.role, u.role_id,
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
    userId: user.id, tenantId: user.tenant_id, role: user.role, email: user.email, roleId: user.role_id,
    canEditDevices: user.can_edit_devices, canEditAlertRules: user.can_edit_alert_rules, canManageUsers: user.can_manage_users
  });
  return { token };
});

app.addHook("onRequest", async (request, reply) => {
  const publicPaths = ["/health", "/api/v1/auth/register", "/api/v1/auth/login"];
  if (publicPaths.includes(request.url)) return;
  // Faz E — agent endpoint'leri kendi PSK bazlı kimlik doğrulamasını (handler içinde
  // authenticateAgent ile) kullanıyor, tenant/user context'e ihtiyaç duymuyor.
  if (request.url.split("?")[0].startsWith("/api/v1/agent/")) return;

  // Servisler arası güvenilir çağrılar (örn. NPM Service'in Core Service'e Gateway'i
  // atlayıp doğrudan yaptığı istekler): paylaşılan bir secret ile doğrulanır.
  // Bu istekler gerçek bir kullanıcı/tenant'a ait DEĞİLDİR — isInternalService=true
  // işaretlenir, endpoint'ler tenant-sahiplik kontrolünü bu durumda atlar.
  const internalSecret = request.headers["x-internal-secret"];
  if (internalSecret && internalSecret === process.env.INTERNAL_SERVICE_SECRET) {
    (request as any).auth = { isInternalService: true };
    return;
  }

  const tenantId = request.headers["x-auth-tenant-id"];
  const userId = request.headers["x-auth-user-id"];
  const role = request.headers["x-auth-role"];
  const roleId = request.headers["x-auth-role-id"] as string | undefined;
  const canEditDevices = request.headers["x-auth-can-edit-devices"] === "true";
  const canEditAlertRules = request.headers["x-auth-can-edit-alert-rules"] === "true";
  const canManageUsers = request.headers["x-auth-can-manage-users"] === "true";
  const email = request.headers["x-auth-email"] as string;

  if (!tenantId || !userId) return reply.status(401).send({ error: "Kimlik doğrulama bilgisi eksik" });
  (request as any).auth = { tenantId, userId, role, roleId: roleId || null, canEditDevices, canEditAlertRules, canManageUsers, email, isInternalService: false };
});

// Merkezi audit log: sadece değiştirici (POST/PATCH/PUT/DELETE) istekleri kaydeder.
// GET istekleri loglanmaz (gürültü olur, "kim ne değiştirdi" sorusuna cevap vermez).
const AUDITED_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const AUDIT_EXCLUDED_PATHS = ["/api/v1/auth/register", "/api/v1/auth/login"];
const SENSITIVE_KEY_PATTERN = /password|secret|token|api[_-]?key/i;

// request/response gövdesindeki şifre/secret gibi alanları [gizli] ile değiştirir —
// audit_log'a düz metin şifre/SMTP parolası gibi hassas veri sızmasın diye.
// İki maskeleme stratejisi birlikte çalışır:
// 1) Alan ADINA bakarak (password/secret/token/api_key gibi anahtar kelimeler)
// 2) Kardeş bir "value_type": "secret" alanı varsa, o nesnedeki default_value/value
//    alanları da maskelenir — makrolarda secret olup olmadığı alan adından değil,
//    value_type'tan anlaşıldığı için (bkz. macros/macro_overrides).
function redactSensitive(value: any): any {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (typeof value === "object") {
    const isSecretPayload = (value as any).value_type === "secret";
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      if (isSecretPayload && (key === "default_value" || key === "value")) {
        result[key] = "[gizli]";
      } else {
        result[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[gizli]" : redactSensitive(val);
      }
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
  // internal service çağrıları (örn. /api/v1/internal/resolve-config) gerçek bir kullanıcı
  // eylemi değildir VE bazıları (resolve-config gibi) yanıtında düz metin secret döndürür —
  // bunları audit_log'a hiç yazmıyoruz, tenant_id/user_id de zaten anlamlı değil.
  if (!auth || auth.isInternalService) return payload;

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
  ip_address: z.string().ip().optional(), // interfaces[] verilmişse buradan türetilir
  device_type: z.enum(["switch", "firewall", "server", "load_balancer", "router"]),
  vendor: z.string().optional(),
  location: z.string().optional(),
  tags: z.array(z.string()).optional(),
  structured_tags: z.array(z.object({ tag: z.string(), value: z.string() })).optional(),
  attributes: z.record(z.any()).optional(),
  interfaces: z.array(z.object({
    interface_type: z.enum(["snmp", "ssh", "sql", "web"]),
    ip_address: z.string().optional(),
    port: z.number().optional(),
    snmp_community: z.string().optional()
  })).optional()
});

const UpdateDeviceSchema = z.object({
  name: z.string().min(1).optional(),
  vendor: z.string().optional(),
  location: z.string().optional(),
  tags: z.array(z.string()).optional(),
  structured_tags: z.array(z.object({ tag: z.string(), value: z.string() })).optional(),
  attributes: z.record(z.any()).optional(),
  enabled: z.boolean().optional()
});

app.get("/api/v1/devices", async (request) => {
  const auth = (request as any).auth;
  const query = request.query as { search?: string; status?: string; device_type?: string; tag?: string; limit?: string; page?: string };

  const conditions: string[] = ["tenant_id = $1"];
  const params: any[] = [auth.tenantId];
  let paramIndex = 2;

  // Granüler RBAC: rolün device-group kısıtlaması varsa, sadece 'read'/'write' izinli
  // gruplardaki cihazlar görünür. Hiç kısıtlama tanımlı değilse, eski davranış korunur.
  if (auth.roleId) {
    const permCheck = await pool.query(
      `SELECT device_group_id, permission FROM role_device_group_permissions WHERE role_id = $1`,
      [auth.roleId]
    );
    if (permCheck.rows.length > 0) {
      const allowedGroupIds = permCheck.rows.filter((r: any) => r.permission !== "deny").map((r: any) => r.device_group_id);
      if (allowedGroupIds.length === 0) {
        conditions.push("1 = 0");
      } else {
        conditions.push(`id IN (SELECT device_id FROM device_group_members WHERE device_group_id = ANY($${paramIndex}::uuid[]))`);
        params.push(allowedGroupIds);
        paramIndex++;
      }
    }
  }

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
    `SELECT d.id, d.name, d.ip_address, d.device_type, d.vendor, d.location, d.status, d.attributes, d.created_at, d.enabled, d.tags,
            COUNT(*) OVER()::int as total_count,
            (SELECT COUNT(*)::int FROM template_items ti JOIN device_templates dt2 ON dt2.template_id = ti.template_id WHERE dt2.device_id = d.id) as item_count,
            (SELECT COUNT(*)::int FROM alert_rules ar WHERE ar.device_id = d.id AND ar.is_heartbeat = false) as rule_count,
            (SELECT COALESCE(json_agg(DISTINCT t.name), '[]') FROM device_templates dt3 JOIN alert_templates t ON t.id = dt3.template_id WHERE dt3.device_id = d.id) as template_names,
            (SELECT COALESCE(json_agg(json_build_object('collector_type', dcs.collector_type, 'status', dcs.status, 'last_error', dcs.last_error)), '[]') FROM device_collector_status dcs WHERE dcs.device_id = d.id) as collector_statuses
     FROM devices d WHERE ${conditions.join(" AND ")}
     ORDER BY d.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
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
  const { name, device_type, vendor, location, tags, structured_tags, attributes, interfaces } = parsed.data;
  const finalAttributes = { ...(attributes || {}), ...(tags ? { tags } : {}) };

  // devices.ip_address hâlâ NOT NULL — interfaces[] verilmişse ilk dolu IP'yi (tercihen snmp)
  // devices.ip_address'e yazıyoruz — geriye dönük uyumluluk için.
  const snmpInterface = interfaces?.find((i) => i.interface_type === "snmp" && i.ip_address);
  const firstInterfaceWithIp = interfaces?.find((i) => i.ip_address);
  const finalIpAddress = parsed.data.ip_address || snmpInterface?.ip_address || firstInterfaceWithIp?.ip_address;
  if (!finalIpAddress) {
    return reply.status(400).send({ error: "En az bir interface için IP adresi girilmeli" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO devices (tenant_id, name, ip_address, device_type, vendor, location, attributes, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, ip_address, device_type, created_at`,
      [auth.tenantId, name, finalIpAddress, device_type, vendor || null, location || null, finalAttributes, JSON.stringify(structured_tags || [])]
    );
    const deviceId = result.rows[0].id;

    for (const iface of interfaces || []) {
      if (!iface.ip_address) continue;
      await client.query(
        `INSERT INTO device_interfaces (device_id, interface_type, ip_address, port, snmp_community) VALUES ($1, $2, $3, $4, $5)`,
        [deviceId, iface.interface_type, iface.ip_address, iface.port || null, iface.snmp_community || null]
      );
    }

    await client.query("COMMIT");
    return reply.status(201).send(result.rows[0]);
  } catch (err: any) {
    await client.query("ROLLBACK");
    if (err.code === "23505") {
      if (err.constraint === "uq_devices_tenant_name") {
        return reply.status(409).send({ error: `Bu isimde (${name}) bir cihaz zaten kayıtlı` });
      }
      return reply.status(409).send({ error: `Bu IP adresi (${finalIpAddress}) zaten kayıtlı bir cihaza ait` });
    }
    request.log.error(err);
    return reply.status(500).send({ error: "Cihaz eklenirken hata oluştu" });
  } finally {
    client.release();
  }
});

// Cihaz güncelleme (isim, vendor, lokasyon, tag, attributes)
app.patch("/api/v1/devices/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  const parsed = UpdateDeviceSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { name, vendor, location, tags, structured_tags, attributes, enabled } = parsed.data;

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
       attributes = $6,
       tags = COALESCE($7, tags),
       enabled = COALESCE($8, enabled)
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, name, ip_address, device_type, vendor, location, status, attributes, tags, enabled`,
    [auth.tenantId, id, name, vendor, location, mergedAttributes, structured_tags ? JSON.stringify(structured_tags) : null, enabled]
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

  // Faz 9.1 -- her metrigin nasil gorsellestirilecegini (cizgi grafik / durum zaman
  // cizelgesi / coklu-satir / grafiklenemez) belirlemek icin template item meta verisini
  // (data_type/is_table/value_map_id) de ekliyoruz. Baseline poller'in urettigi metrikler
  // (if_in_octets, cpu_load_1min gibi) hicbir template item'a karsilik gelmez -- bunlar
  // icin mantikli varsayilan (gauge/tekil/haritasiz, yani mevcut cizgi grafik davranisi) kullanilir.
  const itemMeta = new Map<string, { data_type: string; is_table: boolean; value_map_id: string | null }>();

  const directTemplates = await pool.query(`SELECT template_id FROM device_templates WHERE device_id = $1`, [query.device_id]);
  if (directTemplates.rows.length > 0) {
    const directIds = directTemplates.rows.map((r) => r.template_id);
    const chainResult = await pool.query(
      `WITH RECURSIVE template_chain AS (
         SELECT id, parent_template_id FROM alert_templates WHERE id = ANY($1::uuid[])
         UNION ALL
         SELECT t.id, t.parent_template_id FROM alert_templates t JOIN template_chain tc ON t.id = tc.parent_template_id
       )
       SELECT DISTINCT id FROM template_chain`,
      [directIds]
    );
    const templateIds = chainResult.rows.map((r) => r.id);
    if (templateIds.length > 0) {
      const itemsResult = await pool.query(
        `SELECT DISTINCT ON (metric_name) metric_name, data_type, is_table, value_map_id
         FROM template_items WHERE template_id = ANY($1::uuid[])
         ORDER BY metric_name, id`,
        [templateIds]
      );
      for (const row of itemsResult.rows) {
        itemMeta.set(row.metric_name, { data_type: row.data_type, is_table: row.is_table, value_map_id: row.value_map_id });
      }
    }
  }

  // Baseline poller'in topladigi per-interface metrikler (if_in_octets, if_oper_status
  // gibi) hicbir template_item'a karsilik gelmez, dolayisiyla yukaridaki itemMeta'dan
  // is_table bilgisi hic gelmez. Bunun yerine METRIGIN GERCEKTEN kac farkli interface'de
  // veri urettigini de sayiyoruz -- ikisinden BIRI (template_item.is_table VEYA gercekte
  // >1 interface) true ise tablo/coklu-satir olarak isaretliyoruz.
  const interfaceCounts = await pool.query(
    `SELECT metric_name, COUNT(DISTINCT interface) FILTER (WHERE interface IS NOT NULL)::int as cnt
     FROM metrics WHERE tenant_id = $1 AND device_id = $2 AND time >= now() - interval '24 hours'
     GROUP BY metric_name`,
    [auth.tenantId, query.device_id]
  );
  const interfaceCountMap = new Map(interfaceCounts.rows.map((r) => [r.metric_name, r.cnt]));

  return result.rows.map((r) => {
    const meta = itemMeta.get(r.metric_name);
    const hasMultipleInterfaces = (interfaceCountMap.get(r.metric_name) ?? 0) > 1;
    return {
      metric_name: r.metric_name,
      interface: r.interface,
      data_type: meta?.data_type ?? "gauge",
      is_table: (meta?.is_table ?? false) || hasMultipleInterfaces,
      value_map_id: meta?.value_map_id ?? null
    };
  });
});

// ============ ALERTS ============
app.get("/api/v1/alerts", async (request) => {
  const auth = (request as any).auth;
  const query = request.query as {
    status?: "open" | "resolved";
    severity?: string;
    device_id?: string;
    device_group_id?: string;
    from?: string;
    to?: string;
    limit?: string;
    search?: string;
    tags?: string;
    unacknowledged_only?: string;
    sort?: string;
    order?: string;
    page?: string;
  };

  const conditions: string[] = ["a.tenant_id = $1"];
  const params: any[] = [auth.tenantId];
  let paramIndex = 2;

  if (query.status === "open") conditions.push("a.resolved_at IS NULL");
  if (query.status === "resolved") conditions.push("a.resolved_at IS NOT NULL");
  if (query.severity) {
    // Virgülle ayrılmış çoklu severity destekler (örn. "warning,high") -- tek değer
    // verilse de sorunsuz çalışır (tek elemanlı array).
    conditions.push(`a.severity = ANY($${paramIndex}::text[])`);
    params.push(query.severity.split(","));
    paramIndex++;
  }
  if (query.device_id) {
    conditions.push(`a.device_id = $${paramIndex}`);
    params.push(query.device_id);
    paramIndex++;
  }
  if (query.device_group_id) {
    conditions.push(`a.device_id IN (SELECT device_id FROM device_group_members WHERE device_group_id = $${paramIndex})`);
    params.push(query.device_group_id);
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

  if (query.search) {
    conditions.push(`(a.message ILIKE $${paramIndex} OR r.metric_name ILIKE $${paramIndex})`);
    params.push(`%${query.search}%`);
    paramIndex++;
  }
  if (query.tags) {
    // Format: "component:memory,class:os" -- her key:value cifti icin JSONB
    // containment (@>) ile AND kosulu eklenir (tum belirtilen tag'lere sahip olmali).
    for (const pair of query.tags.split(",")) {
      const [tagKey, tagValue] = pair.split(":").map((s) => s.trim());
      if (!tagKey) continue;
      conditions.push(`a.tags @> $${paramIndex}::jsonb`);
      params.push(JSON.stringify([{ tag: tagKey, value: tagValue || "" }]));
      paramIndex++;
    }
  }
  if (query.unacknowledged_only === "true") {
    conditions.push("a.acknowledged_at IS NULL");
  }
  // GUVENLIK: sortColumn kullanici girdisinden (query.sort) geliyor ama SADECE bu
  // whitelist'teki sabit SQL parcalarindan biri secilebiliyor -- dogrudan kullanici
  // girdisi SQL'e hic enjekte edilmiyor, bu yuzden injection riski yok.
  const SORT_COLUMNS: Record<string, string> = {
    triggered_at: "a.triggered_at",
    duration: "a.triggered_at",
    severity: "CASE a.severity WHEN 'disaster' THEN 5 WHEN 'high' THEN 4 WHEN 'average' THEN 3 WHEN 'warning' THEN 2 WHEN 'info' THEN 1 ELSE 0 END"
  };
  const sortColumn = SORT_COLUMNS[query.sort || "triggered_at"] || SORT_COLUMNS.triggered_at;
  const sortOrder = query.order === "asc" ? "ASC" : "DESC";
  // Excel/CSV export'u icin daha yuksek ust sinir (varsayilan hala 50, degismedi).
  const limit = Math.min(Number(query.limit) || 50, 5000);
  const page = Math.max(Number(query.page) || 1, 1);
  const offset = (page - 1) * limit;

  const result = await pool.query(
    `SELECT a.id, a.device_id, d.name as device_name, r.metric_name, a.triggered_at, a.resolved_at, a.severity, a.message,
            a.acknowledged_at, a.acknowledged_by, a.tags,
            COUNT(*) OVER()::int as total_count,
            (SELECT COUNT(*)::int FROM alerts a2 WHERE a2.rule_id = a.rule_id AND a2.device_id = a.device_id
             AND a2.triggered_at >= now() - interval '7 days') as recurrence_count
     FROM alerts a
     JOIN alert_rules r ON a.rule_id = r.id
     LEFT JOIN devices d ON a.device_id = d.id
     WHERE ${conditions.join(" AND ")}
     ORDER BY ${sortColumn} ${sortOrder} LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  const total = result.rows[0]?.total_count ?? 0;
  const items = result.rows.map(({ total_count, ...rest }) => rest);

  return { items, total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) };
});

// Açık alarmların severity başına dağılımı (kaç disaster, kaç warning vb.) -- ana
// listeye ayrı, hızlı-taranan bir özet olarak eklenir. Ana listedeki device_id/
// device_group_id filtreleriyle TUTARLI olması için aynı filtreleri kabul eder, ama
// severity/status'u KENDİSİ zaten dağıtacağı için o ikisini almaz (her zaman "open").
app.get("/api/v1/alerts/severity-summary", async (request) => {
  const auth = (request as any).auth;
  const query = request.query as { device_id?: string; device_group_id?: string };

  const conditions: string[] = ["a.tenant_id = $1", "a.resolved_at IS NULL"];
  const params: any[] = [auth.tenantId];
  let paramIndex = 2;

  if (query.device_id) {
    conditions.push(`a.device_id = $${paramIndex}`);
    params.push(query.device_id);
    paramIndex++;
  }
  if (query.device_group_id) {
    conditions.push(`a.device_id IN (SELECT device_id FROM device_group_members WHERE device_group_id = $${paramIndex})`);
    params.push(query.device_group_id);
    paramIndex++;
  }

  const result = await pool.query(
    `SELECT severity, COUNT(*)::int as count FROM alerts a WHERE ${conditions.join(" AND ")} GROUP BY severity`,
    params
  );
  return result.rows;
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

// Toplu üstlenme (bulk acknowledge): tek bir DB sorgusuyla, N ayrı istek yerine.
// tenant_id kontrolü WHERE'de yapılıyor -- başka bir tenant'ın alarm ID'si
// listeye karışsa bile o satır güncellenmez (sessizce atlanır, hata değil).
const BulkAcknowledgeSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });
app.post("/api/v1/alerts/bulk-acknowledge", async (request, reply) => {
  const auth = (request as any).auth;
  const parsed = BulkAcknowledgeSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const result = await pool.query(
    `UPDATE alerts SET acknowledged_at = now(), acknowledged_by = $1
     WHERE tenant_id = $2 AND id = ANY($3::uuid[])
     RETURNING id`,
    [auth.userId, auth.tenantId, parsed.data.ids]
  );
  return { acknowledged: result.rows.length };
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

// Bir alarmın severity'sini SONRADAN elle değiştirebilme (triage) -- otomatik
// tetiklenen bir alarmın gerçek önem derecesi, kural tanımındaki sabit severity'den
// farklı değerlendirilebilir (örn. "bu aslında sandığımızdan daha kritik/az kritik").
const UpdateAlertSeveritySchema = z.object({
  severity: z.enum(["info", "warning", "average", "high", "disaster"])
});
app.patch("/api/v1/alerts/:id/severity", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  const parsed = UpdateAlertSeveritySchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const result = await pool.query(
    `UPDATE alerts SET severity = $1 WHERE tenant_id = $2 AND id = $3 RETURNING id, severity`,
    [parsed.data.severity, auth.tenantId, id]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Alarm bulunamadı" });
  return result.rows[0];
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
// device_id GEÇERLİ bir UUID değilse boş döner -- bu değer doğrudan ClickHouse SQL
// string'ine gömüldüğü için (queryClickHouse parametreli sorgu desteklemiyor gibi
// görünüyor, tenant_id de aynı şekilde gömülüyor), kullanıcı girdisi olan device_id'yi
// buraya koymadan ÖNCE format doğrulaması yapmak SQL injection'a karşı zorunlu --
// tenant_id JWT'den geldiği için güvenilir ama device_id request.query'den geliyor.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function safeDeviceIdFilter(deviceId: string | undefined): string {
  if (!deviceId || !UUID_RE.test(deviceId)) return "";
  return `AND device_id = '${deviceId}'`;
}

app.get("/api/v1/traffic/top-talkers", async (request, reply) => {
  const auth = (request as any).auth;
  const query = request.query as { hours?: string; limit?: string; device_id?: string };
  const hours = Math.min(Number(query.hours) || 1, 168);
  const limit = Math.min(Number(query.limit) || 20, 100);
  const deviceFilter = safeDeviceIdFilter(query.device_id);
  try {
    const rows = await queryClickHouse(`
      SELECT
        src_ip,
        dst_ip,
        sum(bytes * sampling_rate) AS total_bytes,
        sum(packets * sampling_rate) AS total_packets,
        count(*) AS flow_count
      FROM flows
      WHERE tenant_id = '${auth.tenantId}' AND timestamp >= now() - INTERVAL ${hours} HOUR ${deviceFilter}
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
  const query = request.query as { hours?: string; device_id?: string };
  const hours = Math.min(Number(query.hours) || 1, 168);
  const deviceFilter = safeDeviceIdFilter(query.device_id);
  try {
    const rows = await queryClickHouse(`
      SELECT
        dst_port,
        protocol,
        sum(bytes * sampling_rate) AS total_bytes,
        count(*) AS flow_count
      FROM flows
      WHERE tenant_id = '${auth.tenantId}' AND timestamp >= now() - INTERVAL ${hours} HOUR ${deviceFilter}
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
  const query = request.query as { hours?: string; device_id?: string };
  const hours = Math.min(Number(query.hours) || 1, 168);
  const deviceFilter = safeDeviceIdFilter(query.device_id);
  try {
    const rows = await queryClickHouse(`
      SELECT
        sum(bytes * sampling_rate) AS total_bytes,
        sum(packets * sampling_rate) AS total_packets,
        count(*) AS flow_count,
        count(DISTINCT src_ip) AS unique_sources,
        count(DISTINCT dst_ip) AS unique_destinations
      FROM flows
      WHERE tenant_id = '${auth.tenantId}' AND timestamp >= now() - INTERVAL ${hours} HOUR ${deviceFilter}
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

  let result;
  try {
    result = await pool.query(
      `INSERT INTO device_links (tenant_id, device_a_id, device_b_id, interface_a, interface_b)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, device_a_id, device_b_id, interface_a, interface_b`,
      [auth.tenantId, device_a_id, device_b_id, interface_a || null, interface_b || null]
    );
  } catch (err: any) {
    if (err.code === "23505") {
      return reply.status(409).send({ error: "Bu iki cihaz arasında zaten bir bağlantı tanımlı" });
    }
    throw err;
  }
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
  })).default([]) // artık boş olabilir — toplu import senaryosunda kurallar sonradan eklenir
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
            COUNT(DISTINCT ar.device_id)::int as device_count,
            (SELECT COUNT(*)::int FROM web_scenarios ws WHERE ws.template_id = t.id) as web_scenario_count
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
            r.depends_on_template_rule_id, dr.metric_name as depends_on_metric_name,
            r.recovery_threshold, r.tags, r.expression_ast, r.display_expression
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

// Şablonu bir device group'a VE/VEYA tek bir cihaza uygula: hedef cihaz(lar) için
// template kurallarının birer KOPYASINI alert_rules'a ekler (referans değil — cihaz
// sonradan bağımsızlaşabilir). GERÇEK EKSIKLIK DÜZELTMESİ: bu endpoint zaten VARDI ve
// doğru çalışıyordu, ama (a) sadece device_group_id kabul ediyordu (tek cihaza template
// atamak -- device_templates -- bu endpoint'i HİÇ tetiklemiyordu), (b) import script'i
// bunu HİÇ ÇAĞIRMIYORDU. Sonuç: 43 template kuralı tanımlanmıştı ama gerçek alert_rules
// tarafında pratikte hiçbiri devrede değildi. device_id desteği eklendi ki import
// script'i (ve gelecekte dashboard) tek bir cihaza da doğrudan uygulayabilsin.
const ApplyTemplateSchema = z.object({
  device_group_id: z.string().uuid().optional(),
  device_id: z.string().uuid().optional()
}).refine((data) => !!data.device_group_id || !!data.device_id, {
  message: "device_group_id veya device_id alanlarından en az biri gerekli"
});

// Bir template'in TÜM kurallarını (basit + expression), verilen cihaz listesine uygular
// -- /apply endpoint'i VE cihaza template atama (POST /devices/:id/templates) TARAFINDAN
// ortak kullanılır. Idempotent (ON CONFLICT ile günceller), makro çözümlemesi cihaz
// bazında yapılır. rulesResult, çağıran tarafından önceden çekilmiş olmalı (aynı template
// için birden fazla cihaza uygulanırken tekrar tekrar sorgulanmasını önlemek için).
async function applyTemplateRulesToDevices(
  rulesResult: { rows: any[] },
  deviceIds: string[],
  tenantId: string
): Promise<number> {
  let created = 0;
  for (const deviceId of deviceIds) {
    // Bu cihaz için template_rule_id -> yeni oluşturulan alert_rule.id eşlemesi
    const templateRuleIdToNewRuleId = new Map<string, string>();

    for (const rule of rulesResult.rows) {
      // expression_ast dolu ise (cok-metrikli ifade kurali), threshold/threshold_macro_key
      // bu kurala hic uygulanmaz -- ONUN YERINE, AST icindeki "macro" node'lari BURADA
      // (cihaza uygulama ANINDA, tek seferlik) gercek sayisal degere cevrilip "literal"
      // node'a donusturulur -- alarm-engine hic makro cozumlemesi yapmaz, sadece hazir
      // sayilarla islem yapar (basit kurallarin threshold_macro_key mantigiyla tutarli).
      let effectiveThreshold = rule.metric_name ? Number(rule.threshold) : null;
      if (rule.metric_name && rule.threshold_macro_key) {
        const resolved = await resolveNumericMacro(rule.threshold_macro_key, tenantId, deviceId);
        if (resolved !== null) effectiveThreshold = resolved;
      }
      let resolvedExpressionAst = rule.expression_ast;
      if (resolvedExpressionAst) {
        resolvedExpressionAst = await resolveExpressionMacros(resolvedExpressionAst, tenantId, deviceId);
      }
      // Idempotent: aynı (device_id, template_rule_id) çifti zaten varsa, yeni satır eklemek
      // yerine mevcut kuralı GÜNCELLER — hem tekrar-uygulamada çoğalmayı önler, hem de
      // template'te sonradan yapılan değişikliklerin mevcut cihazlara yansımasını sağlar.
      const inserted = await pool.query(
        `INSERT INTO alert_rules (tenant_id, source_module, metric_name, condition, threshold, duration_seconds, device_id, severity, template_rule_id, expression_ast, display_expression)
         VALUES ($1, 'npm', $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (device_id, template_rule_id) WHERE template_rule_id IS NOT NULL
         DO UPDATE SET condition = EXCLUDED.condition, threshold = EXCLUDED.threshold,
                        duration_seconds = EXCLUDED.duration_seconds, severity = EXCLUDED.severity,
                        expression_ast = EXCLUDED.expression_ast, display_expression = EXCLUDED.display_expression
         RETURNING id`,
        [tenantId, rule.metric_name, rule.condition, effectiveThreshold, rule.duration_seconds, deviceId, rule.severity, rule.id,
         resolvedExpressionAst ? JSON.stringify(resolvedExpressionAst) : null, rule.display_expression || null]
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
  return created;
}

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
    `SELECT id, metric_name, condition, threshold, duration_seconds, severity, depends_on_template_rule_id, threshold_macro_key, expression_ast, display_expression
     FROM alert_template_rules WHERE template_id = $1`,
    [id]
  );
  if (rulesResult.rows.length === 0) return reply.status(404).send({ error: "Şablonda kural yok" });

  const deviceIdSet = new Set<string>();

  if (parsed.data.device_group_id) {
    const groupCheck = await pool.query(
      `SELECT id FROM device_groups WHERE id = $1 AND tenant_id = $2`,
      [parsed.data.device_group_id, auth.tenantId]
    );
    if (groupCheck.rows.length === 0) return reply.status(404).send({ error: "Host grubu bulunamadı" });

    const membersResult = await pool.query(
      `SELECT device_id FROM device_group_members WHERE device_group_id = $1`,
      [parsed.data.device_group_id]
    );
    for (const r of membersResult.rows) deviceIdSet.add(r.device_id);
  }

  if (parsed.data.device_id) {
    const deviceCheck = await pool.query(
      `SELECT id FROM devices WHERE id = $1 AND tenant_id = $2`,
      [parsed.data.device_id, auth.tenantId]
    );
    if (deviceCheck.rows.length === 0) return reply.status(404).send({ error: "Cihaz bulunamadı" });
    deviceIdSet.add(parsed.data.device_id);
  }

  const deviceIds = Array.from(deviceIdSet);
  const created = await applyTemplateRulesToDevices(rulesResult, deviceIds, auth.tenantId);

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


const CreateRoleSchema = z.object({
  name: z.string().min(1),
  can_edit_devices: z.boolean().default(false),
  can_edit_alert_rules: z.boolean().default(false),
  can_manage_users: z.boolean().default(false)
});

app.post("/api/v1/user-roles", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canManageUsers) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const parsed = CreateRoleSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { name, can_edit_devices, can_edit_alert_rules, can_manage_users } = parsed.data;

  try {
    const result = await pool.query(
      `INSERT INTO user_roles (tenant_id, name, can_edit_devices, can_edit_alert_rules, can_manage_users)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, can_edit_devices, can_edit_alert_rules, can_manage_users`,
      [auth.tenantId, name, can_edit_devices, can_edit_alert_rules, can_manage_users]
    );
    return reply.status(201).send(result.rows[0]);
  } catch (err: any) {
    if (err.code === "23505") return reply.status(409).send({ error: "Bu isimde bir rol zaten var" });
    throw err;
  }
});

const UpdateRoleSchema = z.object({
  name: z.string().min(1).optional(),
  can_edit_devices: z.boolean().optional(),
  can_edit_alert_rules: z.boolean().optional(),
  can_manage_users: z.boolean().optional()
});

app.patch("/api/v1/user-roles/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canManageUsers) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  const parsed = UpdateRoleSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { name, can_edit_devices, can_edit_alert_rules, can_manage_users } = parsed.data;

  const result = await pool.query(
    `UPDATE user_roles SET
       name = COALESCE($3, name),
       can_edit_devices = COALESCE($4, can_edit_devices),
       can_edit_alert_rules = COALESCE($5, can_edit_alert_rules),
       can_manage_users = COALESCE($6, can_manage_users)
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, name, can_edit_devices, can_edit_alert_rules, can_manage_users`,
    [auth.tenantId, id, name, can_edit_devices, can_edit_alert_rules, can_manage_users]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Rol bulunamadı" });
  return result.rows[0];
});

app.delete("/api/v1/user-roles/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canManageUsers) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };

  const usersWithRole = await pool.query(`SELECT COUNT(*)::int as count FROM users WHERE role_id = $1`, [id]);
  if (usersWithRole.rows[0].count > 0) {
    return reply.status(409).send({ error: "Bu role atanmış kullanıcılar var, önce onları başka bir role taşıyın" });
  }

  await pool.query(`DELETE FROM user_roles WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
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
  formula_oids: z.record(z.string()).optional(),
  collector_type: z.string().default("snmp"),
  connection_config: z.record(z.any()).default({}),
  master_item_id: z.string().uuid().nullable().optional(),
  tags: z.array(z.object({ tag: z.string(), value: z.string() })).default([]),
  discovery_filter_regex: z.string().optional(),
  value_map_id: z.string().uuid().optional()
});

app.get("/api/v1/alert-templates/:id/items", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("alert_templates", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Şablon bulunamadı" });
  }
  const result = await pool.query(
    `SELECT ti.id, ti.metric_name, ti.oid, ti.data_type, ti.unit, ti.polling_interval_seconds, ti.is_table,
            ti.collector_type, ti.connection_config, ti.value_map_id, vm.name as value_map_name, ti.tags
     FROM template_items ti
     LEFT JOIN value_maps vm ON vm.id = ti.value_map_id
     WHERE ti.template_id = $1 ORDER BY ti.metric_name`,
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

  const { metric_name, oid, data_type, unit, polling_interval_seconds, is_table, formula, formula_oids, collector_type, connection_config, master_item_id, tags, discovery_filter_regex, value_map_id } = parsed.data;
  const result = await pool.query(
    `INSERT INTO template_items (template_id, metric_name, oid, data_type, unit, polling_interval_seconds, is_table, formula, formula_oids, collector_type, connection_config, master_item_id, tags, discovery_filter_regex, value_map_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id, metric_name, oid, data_type, unit, polling_interval_seconds, is_table, formula, formula_oids, collector_type, connection_config, master_item_id, tags, discovery_filter_regex, value_map_id`,
    [id, metric_name, oid || null, data_type, unit || null, polling_interval_seconds, is_table, formula || null, formula_oids ? JSON.stringify(formula_oids) : null, collector_type, JSON.stringify(connection_config), master_item_id || null, JSON.stringify(tags), discovery_filter_regex || null, value_map_id || null]
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

  // GERÇEK EKSIKLIK DÜZELTMESİ: bu endpoint önceden SADECE device_templates'e kayıt
  // ekliyordu -- template'in alarm kuralları hiçbir zaman otomatik uygulanmıyordu,
  // kullanıcının ayrıca /apply çağırması (ki dashboard'da böyle bir buton da yoktu)
  // gerekiyordu. Artık cihaza bir template atandığı ANDA, o template'in kuralları da
  // otomatik uygulanıyor -- "izleme" ile "alarm" iki ayrı adım olmaktan çıkıyor. Kuralsız
  // bir template (henüz hiç threshold tanımlanmamış) burada sessizce atlanır, hata değildir.
  const rulesResult = await pool.query(
    `SELECT id, metric_name, condition, threshold, duration_seconds, severity, depends_on_template_rule_id, threshold_macro_key, expression_ast, display_expression
     FROM alert_template_rules WHERE template_id = $1`,
    [parsed.data.template_id]
  );
  let rulesApplied = 0;
  if (rulesResult.rows.length > 0) {
    rulesApplied = await applyTemplateRulesToDevices(rulesResult, [id], auth.tenantId);
  }

  return reply.status(201).send({ device_id: id, template_id: parsed.data.template_id, rulesApplied });
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

  // Güvenilir internal servis çağrısı (NPM Service) tenant kontrolünü atlar —
  // device_id zaten Postgres'ten gelen bir UUID, saldırgan tarafından tahmin edilemez
  // formda dışarıya sızmıyor; NPM zaten kendi veritabanı sorgusuyla bulduğu cihazları poll ediyor.
  if (!auth.isInternalService) {
    if (!(await idBelongsToTenant("devices", id, auth.tenantId))) {
      return reply.status(404).send({ error: "Cihaz bulunamadı" });
    }
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
    `SELECT ti.id, ti.metric_name, ti.oid, ti.data_type, ti.unit, ti.polling_interval_seconds, ti.is_table,
            ti.formula, ti.formula_oids, ti.collector_type, ti.connection_config, ti.master_item_id, ti.discovery_filter_regex,
            COALESCE(
              (SELECT json_agg(json_build_object('step_type', ips.step_type, 'params', ips.params) ORDER BY ips.step_order)
               FROM item_preprocessing_steps ips WHERE ips.template_item_id = ti.id),
              '[]'
            ) as preprocessing
     FROM template_items ti WHERE ti.template_id = ANY($1::uuid[])`,
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

// GERÇEK EKSIKLIK DÜZELTMESİ: yukarıdaki endpoint, template'in KURALLARI ZATEN
// UYGULANMIŞ cihazları (alert_rules üzerinden) döndürüyor -- template'e device_templates
// üzerinden ATANMIŞ ama kuralları henüz hiç /apply edilmemiş cihazları YAKALAYAMIYOR
// (döngüsel: kural yoksa bu sorgu boş döner). Bu yeni endpoint, doğrudan device_templates
// tablosundan GERÇEK atamaları döner -- import script'inin "bu template'e atanmış ama
// henüz kuralları uygulanmamış cihazları bul, /apply çağır" akışı için gerekli.
app.get("/api/v1/alert-templates/:id/assigned-device-ids", async (request) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  const result = await pool.query(
    `SELECT d.id FROM devices d
     JOIN device_templates dt ON dt.device_id = d.id
     WHERE dt.template_id = $1 AND d.tenant_id = $2`,
    [id, auth.tenantId]
  );
  return result.rows.map((r) => r.id);
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


// ============ MACROS (Zabbix tarzı {$MAKRO} sistemi) ============
// Üç değer tipi var:
//  - numeric: alarm eşiği gibi sayısal değerler (önceki tek kullanım şekli)
//  - string:  host/port/kullanıcı adı gibi düz metin bağlantı bilgisi
//  - secret:  parola/private key — application-level AES-256-GCM ile şifreli saklanır,
//             API yanıtında ASLA gerçek değer (ne düz metin ne şifreli metin) dönmez.
// Bu genelleme, eskiden device_collector_configs + device_credentials tablolarının
// yaptığı işi (cihaza özel bağlantı bilgisi) tek bir mekanizmaya indirger — SSH/SQL
// collector item'ları artık connection_config içinde doğrudan {$SSH_USER} gibi makro
// referansları taşır, çözümleme cihaz/grup override önceliğiyle burada yapılır.

const CreateMacroSchema = z.object({
  key: z.string().regex(/^\{\$[A-Z0-9_.]+\}$/, "Format: {$ISIM_BUYUK_HARF} (nokta da kullanilabilir, orn. {$REDIS.MAX})"),
  value_type: z.enum(["numeric", "string", "secret"]).default("numeric"),
  default_value: z.string().min(1),
  description: z.string().optional()
}).refine((data) => data.value_type !== "numeric" || !Number.isNaN(Number(data.default_value)), {
  message: "value_type 'numeric' olduğunda default_value geçerli bir sayı olmalı",
  path: ["default_value"]
});

// secret tipi makronun değerini API yanıtında maskeler — ne düz metin ne şifreli metin döner.
function maskMacroValue(value: string, valueType: string): string {
  return valueType === "secret" ? "••••••" : value;
}

app.get("/api/v1/macros", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT id, key, value_type, default_value, description FROM macros WHERE tenant_id = $1 ORDER BY key`,
    [auth.tenantId]
  );
  return result.rows.map((r) => ({ ...r, default_value: maskMacroValue(r.default_value, r.value_type) }));
});

app.post("/api/v1/macros", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const parsed = CreateMacroSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { key, value_type, default_value, description } = parsed.data;

  const storedValue = value_type === "secret" ? encryptSecret(default_value) : default_value;

  try {
    const result = await pool.query(
      `INSERT INTO macros (tenant_id, key, value_type, default_value, description) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, key, value_type, default_value, description`,
      [auth.tenantId, key, value_type, storedValue, description || null]
    );
    const row = result.rows[0];
    return reply.status(201).send({ ...row, default_value: maskMacroValue(row.default_value, row.value_type) });
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
  value: z.string().min(1),
  row_context: z.string().nullable().optional() // örn. interface adı — belirtilirse override sadece o satır için geçerli
});

app.get("/api/v1/macros/:id/overrides", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  const macroCheck = await pool.query(`SELECT id, value_type FROM macros WHERE id = $1 AND tenant_id = $2`, [id, auth.tenantId]);
  if (macroCheck.rows.length === 0) return reply.status(404).send({ error: "Makro bulunamadı" });
  const valueType = macroCheck.rows[0].value_type;

  const result = await pool.query(
    `SELECT mo.id, mo.scope_type, mo.scope_id, mo.value, mo.row_context,
            COALESCE(d.name, g.name) as scope_name
     FROM macro_overrides mo
     LEFT JOIN devices d ON d.id = mo.scope_id AND mo.scope_type = 'device'
     LEFT JOIN device_groups g ON g.id = mo.scope_id AND mo.scope_type = 'device_group'
     WHERE mo.macro_id = $1`,
    [id]
  );
  return result.rows.map((r) => ({ ...r, value: maskMacroValue(r.value, valueType) }));
});

app.post("/api/v1/macros/:id/overrides", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  const parsed = SetMacroOverrideSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const macroCheck = await pool.query(`SELECT id, value_type FROM macros WHERE id = $1 AND tenant_id = $2`, [id, auth.tenantId]);
  if (macroCheck.rows.length === 0) return reply.status(404).send({ error: "Makro bulunamadı" });
  const valueType = macroCheck.rows[0].value_type;

  // scope_id'nin de gerçekten bu tenant'a ait olduğunu doğrula
  const scopeTable = parsed.data.scope_type === "device" ? "devices" : "device_groups";
  const scopeCheck = await pool.query(`SELECT id FROM ${scopeTable} WHERE id = $1 AND tenant_id = $2`, [parsed.data.scope_id, auth.tenantId]);
  if (scopeCheck.rows.length === 0) return reply.status(404).send({ error: "Hedef cihaz/grup bulunamadı" });

  const storedValue = valueType === "secret" ? encryptSecret(parsed.data.value) : parsed.data.value;
  const rowContext = parsed.data.row_context || null;

  const result = await pool.query(
    `INSERT INTO macro_overrides (macro_id, scope_type, scope_id, value, row_context) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (macro_id, scope_type, scope_id, (COALESCE(row_context, ''))) DO UPDATE SET value = $4
     RETURNING id, scope_type, scope_id, value, row_context`,
    [id, parsed.data.scope_type, parsed.data.scope_id, storedValue, rowContext]
  );
  const row = result.rows[0];
  return reply.status(201).send({ ...row, value: maskMacroValue(row.value, valueType) });
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

// Bir cihaz için makronun HAM değerini (secret ise hâlâ şifreli hâliyle) ve tipini
// öncelik sırasına göre çözer: device override > device_group override > tenant varsayılanı.
async function resolveMacroRaw(macroKey: string, tenantId: string, deviceId: string, rowContext: string | null = null): Promise<{ valueType: string; value: string } | null> {
  const macroResult = await pool.query(`SELECT id, value_type, default_value FROM macros WHERE tenant_id = $1 AND key = $2`, [tenantId, macroKey]);
  if (macroResult.rows.length === 0) return null;
  const macro = macroResult.rows[0];

  // Öncelik sırası: (1) cihaz + tam satır eşleşmesi (örn. "GigabitEthernet0/1" için özel eşik),
  // (2) cihaz geneli (row_context NULL), (3) grup + satır, (4) grup geneli, (5) varsayılan.
  // Satır eşleşmesi her zaman genel override'dan önce gelir (ORDER BY ile sağlanır).
  const deviceOverride = await pool.query(
    `SELECT value FROM macro_overrides
     WHERE macro_id = $1 AND scope_type = 'device' AND scope_id = $2
       AND (row_context = $3 OR row_context IS NULL)
     ORDER BY (row_context IS NOT NULL) DESC
     LIMIT 1`,
    [macro.id, deviceId, rowContext]
  );
  if (deviceOverride.rows.length > 0) return { valueType: macro.value_type, value: deviceOverride.rows[0].value };

  const groupOverride = await pool.query(
    `SELECT mo.value FROM macro_overrides mo
     JOIN device_group_members dgm ON dgm.device_group_id = mo.scope_id
     JOIN device_groups dg ON dg.id = mo.scope_id
     WHERE mo.macro_id = $1 AND mo.scope_type = 'device_group' AND dgm.device_id = $2
       AND (mo.row_context = $3 OR mo.row_context IS NULL)
     ORDER BY (mo.row_context IS NOT NULL) DESC, dg.created_at DESC
     LIMIT 1`,
    [macro.id, deviceId, rowContext]
  );
  if (groupOverride.rows.length > 0) return { valueType: macro.value_type, value: groupOverride.rows[0].value };

  return { valueType: macro.value_type, value: macro.default_value };
}

// Alarm eşiği gibi sayısal kullanımlar için. Makro yanlışlıkla string/secret tipindeyse
// sessizce NaN dönüp kuralı bozmak yerine null döner ve konsola açık bir uyarı basar.
// expression_ast icindeki "macro" node'larini, cihaza uygulama ANINDA (her degerlendirmede
// degil -- mevcut basit-kural threshold_macro_key mantigiyla tutarli) gercek sayisal
// degerle degistirip "literal" node'a cevirir -- alarm-engine hic makro cozumlemesi
// yapmak zorunda kalmaz, sadece hazir sayilarla islem yapar.
async function resolveExpressionMacros(node: any, tenantId: string, deviceId: string): Promise<any> {
  if (!node || typeof node !== "object") return node;
  if (node.type === "macro") {
    const resolved = await resolveNumericMacro(node.key, tenantId, deviceId);
    return resolved !== null ? { type: "literal", value: resolved } : node; // cozulemezse oldugu gibi birak (null olarak degerlendirilir)
  }
  if (node.type === "logical") {
    return { ...node, children: await Promise.all(node.children.map((c: any) => resolveExpressionMacros(c, tenantId, deviceId))) };
  }
  if (node.type === "comparison" || node.type === "arithmetic") {
    return {
      ...node,
      left: await resolveExpressionMacros(node.left, tenantId, deviceId),
      right: await resolveExpressionMacros(node.right, tenantId, deviceId)
    };
  }
  return node; // function/literal -- degisiklik yok
}

async function resolveNumericMacro(macroKey: string, tenantId: string, deviceId: string, rowContext: string | null = null): Promise<number | null> {
  const resolved = await resolveMacroRaw(macroKey, tenantId, deviceId, rowContext);
  if (!resolved) return null;
  if (resolved.valueType !== "numeric") {
    console.error(`[Makro] ${macroKey} sayısal bir bağlamda kullanıldı ama value_type='${resolved.valueType}' — atlanıyor`);
    return null;
  }
  const num = Number(resolved.value);
  return Number.isNaN(num) ? null : num;
}

// Bağlantı bilgisi (host/port/kullanıcı adı/parola) gibi metinsel kullanımlar için.
// secret tipindeyse şifresi çözülerek düz metin döner — SADECE internal servisler bu
// yola erişebilir (bkz. resolveConfigMacros / /api/v1/internal/resolve-config), asla
// normal (tenant kullanıcısı) bir isteğin sonucuna karışmaz.
async function resolveStringMacro(macroKey: string, tenantId: string, deviceId: string, rowContext: string | null = null): Promise<string | null> {
  const resolved = await resolveMacroRaw(macroKey, tenantId, deviceId, rowContext);
  if (!resolved) return null;
  if (resolved.valueType === "secret") {
    // Henüz hiç override/gerçek değer girilmemiş secret makrolar boş string default'a
    // sahip olabilir (bkz. migration 032) — decryptSecret'ı çökertmek yerine null döneriz.
    if (!resolved.value) return null;
    return decryptSecret(resolved.value);
  }
  return resolved.value;
}

// Bir JSON yapısındaki (template item connection_config gibi) tüm string alanlarda geçen
// {$MAKRO_ADI} referanslarını, verilen cihaz için çözerek yerine koyar. Recursive: iç içe
// obje/dizi alanlarını da gezer (redactSensitive'deki gezinme deseniyle aynı mantık).
const MACRO_REFERENCE_PATTERN = /\{\$[A-Z0-9_]+\}/g;

async function resolveConfigMacros(config: any, tenantId: string, deviceId: string): Promise<any> {
  if (config === null || config === undefined) return config;
  if (Array.isArray(config)) {
    return Promise.all(config.map((item) => resolveConfigMacros(item, tenantId, deviceId)));
  }
  if (typeof config === "object") {
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(config)) {
      result[key] = await resolveConfigMacros(val, tenantId, deviceId);
    }
    return result;
  }
  if (typeof config === "string") {
    const matches = config.match(MACRO_REFERENCE_PATTERN);
    if (!matches) return config;
    let resolved = config;
    for (const macroKey of matches) {
      const value = await resolveStringMacro(macroKey, tenantId, deviceId);
      resolved = resolved.split(macroKey).join(value ?? "");
    }
    return resolved;
  }
  return config;
}

// Internal servisler (Exec/SQL Collector) için — bir template item'ın connection_config'indeki
// {$MAKRO} referanslarını verilen cihaz için çözüp gerçek (secret'lar dahil düz metin) değerleri
// döner. device_collector_configs + device_credentials'in yaptığı işi tek noktada birleştiriyor.
const ResolveConfigSchema = z.object({
  device_id: z.string().uuid(),
  config: z.record(z.any())
});

app.post("/api/v1/internal/resolve-config", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const parsed = ResolveConfigSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const deviceResult = await pool.query(`SELECT tenant_id FROM devices WHERE id = $1`, [parsed.data.device_id]);
  if (deviceResult.rows.length === 0) return reply.status(404).send({ error: "Cihaz bulunamadı" });
  const tenantId = deviceResult.rows[0].tenant_id;

  const resolved = await resolveConfigMacros(parsed.data.config, tenantId, parsed.data.device_id);
  return resolved;
});


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
  depends_on_template_rule_id: z.string().uuid().nullable().optional(),
  recovery_threshold: z.number().nullable().optional(),
  tags: z.array(z.object({ tag: z.string(), value: z.string() })).optional()
});

app.patch("/api/v1/alert-template-rules/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  const parsed = UpdateTemplateRuleSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { condition, threshold, threshold_macro_key, duration_seconds, severity, depends_on_template_rule_id, recovery_threshold, tags } = parsed.data;

  const result = await pool.query(
    `UPDATE alert_template_rules SET
       condition = COALESCE($2, condition),
       threshold = COALESCE($3, threshold),
       threshold_macro_key = $4,
       duration_seconds = COALESCE($5, duration_seconds),
       severity = COALESCE($6, severity),
       depends_on_template_rule_id = $7,
       recovery_threshold = COALESCE($8, recovery_threshold),
       tags = COALESCE($9, tags)
     WHERE id = $1
     RETURNING id, metric_name, condition, threshold, duration_seconds, severity, threshold_macro_key, depends_on_template_rule_id, recovery_threshold, tags`,
    [id, condition, threshold, threshold_macro_key, duration_seconds, severity, depends_on_template_rule_id, recovery_threshold, tags ? JSON.stringify(tags) : null]
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
  metric_name: z.string().min(1).optional(),
  condition: z.enum(["gt", "lt", "eq"]).optional(),
  threshold: z.number().optional(),
  threshold_macro_key: z.string().optional(),
  duration_seconds: z.number().min(30).default(60),
  severity: z.enum(["info", "warning", "average", "high", "disaster"]).default("warning"),
  tags: z.array(z.object({ tag: z.string(), value: z.string() })).default([]),
  recovery_threshold: z.number().optional(),
  expression_ast: z.record(z.any()).optional(),
  display_expression: z.string().optional()
}).refine(
  (data) => (data.metric_name && data.condition) || data.expression_ast,
  { message: "metric_name+condition YA DA expression_ast dolu olmali" }
);
app.post("/api/v1/alert-templates/:id/rules", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const parsed = AddTemplateRuleSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { metric_name, condition, threshold, threshold_macro_key, duration_seconds, severity, tags, recovery_threshold, expression_ast, display_expression } = parsed.data;
  const result = await pool.query(
    `INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity, threshold_macro_key, tags, recovery_threshold, expression_ast, display_expression)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, metric_name, condition, threshold, duration_seconds, severity, tags, recovery_threshold, expression_ast, display_expression`,
    [id, metric_name || null, condition || null, threshold ?? null, duration_seconds, severity, threshold_macro_key || null, JSON.stringify(tags), recovery_threshold || null, expression_ast ? JSON.stringify(expression_ast) : null, display_expression || null]
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
  formula_oids: z.record(z.string()).nullable().optional(),
  discovery_filter_regex: z.string().nullable().optional()
});

app.patch("/api/v1/template-items/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  const parsed = UpdateTemplateItemSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { metric_name, oid, data_type, unit, polling_interval_seconds, formula, formula_oids, discovery_filter_regex } = parsed.data;

  // GÜVENLİK NOTU: Daha önce oid/unit/formula/formula_oids direkt atanıyordu (COALESCE değil) —
  // bu, sadece discovery_filter_regex gibi TEK bir alanı güncellemek isteyen bir PATCH isteğinin
  // bile diğer tüm alanları sessizce NULL'a çevirmesine yol açıyordu (gerçek veri kaybı yaşandı,
  // test sırasında bulundu). Artık hepsi COALESCE ile korunuyor — bir alanı temizlemek gerekirse
  // ayrı bir mekanizma eklenmeli, genel PATCH'in yan etkisi olmamalı.
  const result = await pool.query(
    `UPDATE template_items SET
       metric_name = COALESCE($2, metric_name),
       oid = COALESCE($3, oid),
       data_type = COALESCE($4, data_type),
       unit = COALESCE($5, unit),
       polling_interval_seconds = COALESCE($6, polling_interval_seconds),
       formula = COALESCE($7, formula),
       formula_oids = COALESCE($8, formula_oids),
       discovery_filter_regex = COALESCE($9, discovery_filter_regex)
     WHERE id = $1
     RETURNING id, metric_name, oid, data_type, unit, polling_interval_seconds, formula, formula_oids, discovery_filter_regex`,
    [id, metric_name, oid, data_type, unit, polling_interval_seconds, formula, formula_oids ? JSON.stringify(formula_oids) : null, discovery_filter_regex]
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


// Bir host grubuna tanımlı (aktif/gelecek) bakım pencereleri
app.get("/api/v1/device-groups/:id/maintenance-windows", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  const groupCheck = await pool.query(`SELECT id FROM device_groups WHERE id = $1 AND tenant_id = $2`, [id, auth.tenantId]);
  if (groupCheck.rows.length === 0) return reply.status(404).send({ error: "Grup bulunamadı" });

  const result = await pool.query(
    `SELECT mw.id, mw.name, mw.starts_at, mw.ends_at,
            (mw.starts_at <= now() AND mw.ends_at >= now()) as is_active
     FROM maintenance_windows mw
     JOIN maintenance_window_groups mwg ON mwg.maintenance_window_id = mw.id
     WHERE mwg.device_group_id = $1 AND mw.ends_at >= now()
     ORDER BY mw.starts_at`,
    [id]
  );
  return result.rows;
});


app.get("/api/v1/collector-types", async () => {
  const result = await pool.query(
    `SELECT key, display_name, category, config_schema, handler_service, requires_device_config
     FROM collector_types WHERE active = true ORDER BY category, display_name`
  );
  return result.rows;
});


// Sadece güvenilir internal servisler (SQL Collector, ileride diğer collector'lar) için —
// tüm tenant'lardaki tüm cihazların temel bilgisini döner (kendi polling döngüleri için).
app.get("/api/v1/internal/devices", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  // Faz 8.5 çoklu-interface deseni: collector_type verilirse, o collector tipine ait
  // device_interfaces kaydı varsa ip_address oradan gelir (host()/inet ile temizlenmiş),
  // yoksa devices.ip_address'e (eski, tek-IP model) geri düşülür — geriye dönük uyumluluk.
  const { collector_type } = request.query as { collector_type?: string };

  const result = collector_type
    ? await pool.query(
        `SELECT d.id, d.tenant_id, d.name,
                COALESCE(di.ip_address, host(d.ip_address)) as ip_address
         FROM devices d
         LEFT JOIN device_interfaces di ON di.device_id = d.id AND di.interface_type = $1
         WHERE d.status IN ('active', 'down', 'unknown')`,
        [collector_type]
      )
    : await pool.query(
        `SELECT id, tenant_id, name, host(ip_address) as ip_address FROM devices WHERE status IN ('active', 'down', 'unknown')`
      );
  return result.rows;
});


// ============ NEEDED COLLECTOR TYPES ============
// Bir cihazın atanmış template'lerindeki item'ların gerçekten hangi collector_type'ları
// kullandığını VE her birinin hangi makrolara bağlı olduğunu döner — Bağlantı Ayarları
// sekmesinde hem "eksik" uyarısını hem de doğrudan düzenlenebilir makro override
// formlarını (device-scope) göstermek için.
app.get("/api/v1/devices/:id/needed-collector-types", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  if (!(await idBelongsToTenant("devices", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Cihaz bulunamadı" });
  }

  const directTemplates = await pool.query(`SELECT template_id FROM device_templates WHERE device_id = $1`, [id]);
  if (directTemplates.rows.length === 0) return [];

  const directIds = directTemplates.rows.map((r) => r.template_id);
  const chainResult = await pool.query(
    `WITH RECURSIVE template_chain AS (
       SELECT id, parent_template_id FROM alert_templates WHERE id = ANY($1::uuid[])
       UNION ALL
       SELECT t.id, t.parent_template_id FROM alert_templates t JOIN template_chain tc ON t.id = tc.parent_template_id
     )
     SELECT DISTINCT id FROM template_chain`,
    [directIds]
  );
  const templateIds = chainResult.rows.map((r) => r.id);
  if (templateIds.length === 0) return [];

  const itemsResult = await pool.query(
    `SELECT ti.collector_type, ct.display_name, ti.connection_config
     FROM template_items ti
     JOIN collector_types ct ON ct.key = ti.collector_type
     WHERE ti.template_id = ANY($1::uuid[]) AND ct.requires_device_config = true`,
    [templateIds]
  );
  if (itemsResult.rows.length === 0) return [];

  const macrosByType = new Map<string, Set<string>>();
  const displayNameByType = new Map<string, string>();
  for (const row of itemsResult.rows) {
    if (!macrosByType.has(row.collector_type)) macrosByType.set(row.collector_type, new Set());
    displayNameByType.set(row.collector_type, row.display_name);
    const raw = JSON.stringify(row.connection_config || {});
    const matches = raw.match(MACRO_REFERENCE_PATTERN) || [];
    for (const m of matches) macrosByType.get(row.collector_type)!.add(m);
  }

  const output: {
    collector_type: string;
    display_name: string;
    is_configured: boolean;
    macros: { macro_id: string; key: string; value_type: string; has_device_override: boolean; current_value: string | null }[];
  }[] = [];

  for (const [collectorType, macroKeys] of macrosByType) {
    const macroInfos: { macro_id: string; key: string; value_type: string; has_device_override: boolean; current_value: string | null }[] = [];
    let hasAnyOverride = false;

    for (const macroKey of macroKeys) {
      const macroResult = await pool.query(`SELECT id, value_type FROM macros WHERE tenant_id = $1 AND key = $2`, [auth.tenantId, macroKey]);
      if (macroResult.rows.length === 0) continue;
      const macro = macroResult.rows[0];

      const overrideResult = await pool.query(
        `SELECT value FROM macro_overrides WHERE macro_id = $1 AND scope_type = 'device' AND scope_id = $2`,
        [macro.id, id]
      );
      const hasDeviceOverride = overrideResult.rows.length > 0;
      if (hasDeviceOverride) hasAnyOverride = true;

      macroInfos.push({
        macro_id: macro.id,
        key: macroKey,
        value_type: macro.value_type,
        has_device_override: hasDeviceOverride,
        current_value: hasDeviceOverride ? maskMacroValue(overrideResult.rows[0].value, macro.value_type) : null
      });
    }

    output.push({
      collector_type: collectorType,
      display_name: displayNameByType.get(collectorType)!,
      is_configured: hasAnyOverride,
      macros: macroInfos
    });
  }
  return output;
});


// ============ ITEM PREPROCESSING (change_per_second, multiplier, jsonpath, regex) ============

const AddPreprocessingSchema = z.object({
  step_type: z.enum(["change_per_second", "multiplier", "jsonpath", "regex"]),
  params: z.record(z.any()).default({}),
  step_order: z.number().default(1)
});

app.get("/api/v1/template-items/:id/preprocessing", async (request) => {
  const { id } = request.params as { id: string };
  const result = await pool.query(
    `SELECT id, step_order, step_type, params FROM item_preprocessing_steps WHERE template_item_id = $1 ORDER BY step_order`,
    [id]
  );
  return result.rows;
});

app.post("/api/v1/template-items/:id/preprocessing", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  const parsed = AddPreprocessingSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const result = await pool.query(
    `INSERT INTO item_preprocessing_steps (template_item_id, step_order, step_type, params)
     VALUES ($1, $2, $3, $4) RETURNING id, step_order, step_type, params`,
    [id, parsed.data.step_order, parsed.data.step_type, JSON.stringify(parsed.data.params)]
  );
  return reply.status(201).send(result.rows[0]);
});

app.delete("/api/v1/item-preprocessing/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM item_preprocessing_steps WHERE id = $1`, [id]);
  return reply.status(204).send();
});


// ============ VALUE MAPS (ham sayısal değeri okunur etikete çevirme — Zabbix "value map" karşılığı) ============

const CreateValueMapSchema = z.object({
  name: z.string().min(1),
  mappings: z.array(z.object({ value: z.string(), label: z.string() })).min(1)
});

app.get("/api/v1/value-maps", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT id, name, mappings FROM value_maps WHERE tenant_id = $1 ORDER BY name`,
    [auth.tenantId]
  );
  return result.rows;
});

app.post("/api/v1/value-maps", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const parsed = CreateValueMapSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  try {
    const result = await pool.query(
      `INSERT INTO value_maps (tenant_id, name, mappings) VALUES ($1, $2, $3)
       RETURNING id, name, mappings`,
      [auth.tenantId, parsed.data.name, JSON.stringify(parsed.data.mappings)]
    );
    return reply.status(201).send(result.rows[0]);
  } catch (err: any) {
    if (err.code === "23505") return reply.status(409).send({ error: "Bu isimde bir value map zaten var" });
    throw err;
  }
});

app.delete("/api/v1/value-maps/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM value_maps WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});

// Bir template item'a value map ata
app.patch("/api/v1/template-items/:id/value-map", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const { value_map_id } = request.body as { value_map_id: string | null };

  const result = await pool.query(
    `UPDATE template_items SET value_map_id = $1 WHERE id = $2 RETURNING id, value_map_id`,
    [value_map_id, id]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Item bulunamadı" });
  return result.rows[0];
});


// ============ WEB SCENARIOS (çok adımlı HTTP durum kontrolü — Zabbix "Web Scenario" karşılığı) ============

const CreateScenarioSchema = z.object({
  name: z.string().min(1),
  user_agent: z.string().optional(),
  polling_interval_seconds: z.number().min(30).default(300),
  steps: z.array(z.object({
    name: z.string().min(1),
    url: z.string().min(1),
    expected_status_code: z.number().default(200)
  })).min(1)
});

app.get("/api/v1/alert-templates/:id/web-scenarios", async (request) => {
  const { id } = request.params as { id: string };
  const result = await pool.query(
    `SELECT ws.id, ws.name, ws.user_agent, ws.polling_interval_seconds,
            COUNT(wss.id)::int as step_count
     FROM web_scenarios ws
     LEFT JOIN web_scenario_steps wss ON wss.scenario_id = ws.id
     WHERE ws.template_id = $1
     GROUP BY ws.id ORDER BY ws.name`,
    [id]
  );
  return result.rows;
});

app.get("/api/v1/web-scenarios/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const scenarioResult = await pool.query(
    `SELECT id, template_id, name, user_agent, polling_interval_seconds FROM web_scenarios WHERE id = $1`,
    [id]
  );
  if (scenarioResult.rows.length === 0) return reply.status(404).send({ error: "Senaryo bulunamadı" });

  const stepsResult = await pool.query(
    `SELECT id, step_order, name, url, expected_status_code FROM web_scenario_steps WHERE scenario_id = $1 ORDER BY step_order`,
    [id]
  );
  return { ...scenarioResult.rows[0], steps: stepsResult.rows };
});

app.post("/api/v1/alert-templates/:id/web-scenarios", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  const templateCheck = await pool.query(`SELECT id FROM alert_templates WHERE id = $1 AND tenant_id = $2`, [id, auth.tenantId]);
  if (templateCheck.rows.length === 0) return reply.status(404).send({ error: "Şablon bulunamadı" });

  const parsed = CreateScenarioSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { name, user_agent, polling_interval_seconds, steps } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const scenarioResult = await client.query(
      `INSERT INTO web_scenarios (template_id, name, user_agent, polling_interval_seconds) VALUES ($1, $2, $3, $4) RETURNING id`,
      [id, name, user_agent || null, polling_interval_seconds]
    );
    const scenarioId = scenarioResult.rows[0].id;

    for (let i = 0; i < steps.length; i++) {
      await client.query(
        `INSERT INTO web_scenario_steps (scenario_id, step_order, name, url, expected_status_code) VALUES ($1, $2, $3, $4, $5)`,
        [scenarioId, i + 1, steps[i].name, steps[i].url, steps[i].expected_status_code]
      );
    }
    await client.query("COMMIT");
    return reply.status(201).send({ id: scenarioId, name });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

app.delete("/api/v1/web-scenarios/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM web_scenarios WHERE id = $1`, [id]);
  return reply.status(204).send();
});

// Internal servis (Web Collector) için — tüm tenant'lardaki tüm senaryoları döner
app.get("/api/v1/internal/web-scenarios", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const result = await pool.query(
    `SELECT ws.id, ws.name, ws.user_agent, ws.polling_interval_seconds, t.tenant_id,
            dt.device_id
     FROM web_scenarios ws
     JOIN alert_templates t ON t.id = ws.template_id
     LEFT JOIN device_templates dt ON dt.template_id = t.id`
  );
  return result.rows;
});

app.get("/api/v1/internal/web-scenarios/:id/steps", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });
  const { id } = request.params as { id: string };
  const result = await pool.query(
    `SELECT step_order, name, url, expected_status_code FROM web_scenario_steps WHERE scenario_id = $1 ORDER BY step_order`,
    [id]
  );
  return result.rows;
});


// Bir cihaza atanmış template'lerin (Item connection_config + Rule threshold_macro_key
// içindeki) kullandığı TÜM makro referanslarını bulur, her biri için çözülmüş değeri
// (override var mı, hangi kaynaktan) döner. Device Detail'in genel "Makrolar" sekmesi
// bunu kullanır — artık collector-tipine özel form yok, tek genel makro listesi var.
app.get("/api/v1/devices/:id/used-macros", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  if (!(await idBelongsToTenant("devices", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Cihaz bulunamadı" });
  }

  const directTemplates = await pool.query(`SELECT template_id FROM device_templates WHERE device_id = $1`, [id]);
  if (directTemplates.rows.length === 0) return [];

  const directIds = directTemplates.rows.map((r) => r.template_id);
  const chainResult = await pool.query(
    `WITH RECURSIVE template_chain AS (
       SELECT id, parent_template_id FROM alert_templates WHERE id = ANY($1::uuid[])
       UNION ALL
       SELECT t.id, t.parent_template_id FROM alert_templates t JOIN template_chain tc ON t.id = tc.parent_template_id
     )
     SELECT DISTINCT id FROM template_chain`,
    [directIds]
  );
  const templateIds = chainResult.rows.map((r) => r.id);
  if (templateIds.length === 0) return [];

  // connection_config JSONB'sindeki tüm string değerlerden {$...} desenini regex ile çıkar
  const itemsResult = await pool.query(
    `SELECT connection_config::text as cfg_text FROM template_items WHERE template_id = ANY($1::uuid[])`,
    [templateIds]
  );
  const rulesResult = await pool.query(
    `SELECT threshold_macro_key FROM alert_template_rules WHERE template_id = ANY($1::uuid[]) AND threshold_macro_key IS NOT NULL`,
    [templateIds]
  );

  const macroKeys = new Set<string>();
  const macroPattern = /\{\$[A-Z0-9_]+\}/g;

  for (const row of itemsResult.rows) {
    const matches = (row.cfg_text || "").match(macroPattern);
    if (matches) matches.forEach((m: string) => macroKeys.add(m));
  }
  for (const row of rulesResult.rows) {
    if (row.threshold_macro_key) macroKeys.add(row.threshold_macro_key);
  }

  const results = [];
  for (const key of macroKeys) {
    const resolved = await resolveMacroRaw(key, auth.tenantId, id);
    const macroInfo = await pool.query(`SELECT id, description, value_type FROM macros WHERE tenant_id = $1 AND key = $2`, [auth.tenantId, key]);

    // Bu cihaz için gerçek bir override var mı diye ayrıca kontrol et (sadece "çözülmüş değer" değil, kaynağını da göster)
    const overrideCheck = macroInfo.rows.length > 0 ? await pool.query(
      `SELECT id FROM macro_overrides WHERE macro_id = $1 AND scope_type = 'device' AND scope_id = $2`,
      [macroInfo.rows[0].id, id]
    ) : { rows: [] };

    results.push({
      key,
      macro_id: macroInfo.rows[0]?.id || null,
      description: macroInfo.rows[0]?.description || null,
      value_type: resolved?.valueType || "string",
      resolved_value: resolved ? maskMacroValue(resolved.value, resolved.valueType) : null,
      has_device_override: overrideCheck.rows.length > 0,
      exists: macroInfo.rows.length > 0
    });
  }

  return results.sort((a, b) => a.key.localeCompare(b.key));
});


// ============ API TOKENS (programatik/uzun ömürlü erişim — entegrasyonlar için) ============

const CreateApiTokenSchema = z.object({
  name: z.string().min(1),
  expires_in_days: z.number().min(1).max(3650).optional() // yoksa süresiz
});

app.get("/api/v1/api-tokens", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT id, name, expires_at, last_used_at, revoked_at, created_at
     FROM api_tokens WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
    [auth.tenantId, auth.userId]
  );
  return result.rows;
});

app.post("/api/v1/api-tokens", async (request, reply) => {
  const auth = (request as any).auth;
  const parsed = CreateApiTokenSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const { rawToken, tokenHash } = generateApiToken();
  const expiresAt = parsed.data.expires_in_days
    ? new Date(Date.now() + parsed.data.expires_in_days * 86400000)
    : null;

  const result = await pool.query(
    `INSERT INTO api_tokens (tenant_id, user_id, name, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, expires_at, created_at`,
    [auth.tenantId, auth.userId, parsed.data.name, tokenHash, expiresAt]
  );

  // Ham token SADECE bu yanıtta, bir kez gösterilir — bir daha asla geri dönmez.
  return reply.status(201).send({ ...result.rows[0], token: rawToken });
});

app.delete("/api/v1/api-tokens/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  await pool.query(
    `UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [id, auth.tenantId, auth.userId]
  );
  return reply.status(204).send();
});


// Gateway'in API token'ları doğrulaması için internal endpoint — ham token hash'lenip
// veritabanında aranır, süresi dolmuş/iptal edilmiş token'lar reddedilir.
app.post("/api/v1/internal/verify-api-token", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const { token } = request.body as { token: string };
  const tokenHash = hashApiToken(token);

  const result = await pool.query(
    `SELECT at.id, at.tenant_id, at.user_id, at.expires_at, at.revoked_at,
            u.email, u.role, ur.can_edit_devices, ur.can_edit_alert_rules, ur.can_manage_users
     FROM api_tokens at
     JOIN users u ON u.id = at.user_id
     LEFT JOIN user_roles ur ON ur.id = u.role_id
     WHERE at.token_hash = $1`,
    [tokenHash]
  );

  if (result.rows.length === 0) return reply.status(401).send({ error: "Geçersiz token" });
  const row = result.rows[0];
  if (row.revoked_at) return reply.status(401).send({ error: "Token iptal edilmiş" });
  if (row.expires_at && new Date(row.expires_at) < new Date()) return reply.status(401).send({ error: "Token süresi dolmuş" });

  await pool.query(`UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, [row.id]);

  return {
    userId: row.user_id, tenantId: row.tenant_id, email: row.email, role: row.role,
    canEditDevices: row.can_edit_devices || false,
    canEditAlertRules: row.can_edit_alert_rules || false,
    canManageUsers: row.can_manage_users || false
  };
});


// ============ ROLE - DEVICE GROUP PERMISSIONS (granüler RBAC) ============
// Bir rolün SADECE belirli host gruplarına erişimi olmasını sağlar. Hiç kayıt yoksa
// (varsayılan davranış korunur) rol, canEditDevices/canEditAlertRules bayraklarına göre
// TÜM cihazlara erişebilir — bu tablo sadece kısıtlama eklemek istendiğinde devreye girer.

const SetRoleDeviceGroupPermissionSchema = z.object({
  device_group_id: z.string().uuid(),
  permission: z.enum(["read", "write", "deny"])
});

app.get("/api/v1/user-roles/:id/device-group-permissions", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  const roleCheck = await pool.query(`SELECT id FROM user_roles WHERE id = $1 AND tenant_id = $2`, [id, auth.tenantId]);
  if (roleCheck.rows.length === 0) return reply.status(404).send({ error: "Rol bulunamadı" });

  const result = await pool.query(
    `SELECT rdgp.id, rdgp.device_group_id, rdgp.permission, dg.name as device_group_name
     FROM role_device_group_permissions rdgp
     JOIN device_groups dg ON dg.id = rdgp.device_group_id
     WHERE rdgp.role_id = $1`,
    [id]
  );
  return result.rows;
});

app.post("/api/v1/user-roles/:id/device-group-permissions", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canManageUsers) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  const roleCheck = await pool.query(`SELECT id FROM user_roles WHERE id = $1 AND tenant_id = $2`, [id, auth.tenantId]);
  if (roleCheck.rows.length === 0) return reply.status(404).send({ error: "Rol bulunamadı" });

  const parsed = SetRoleDeviceGroupPermissionSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const groupCheck = await pool.query(`SELECT id FROM device_groups WHERE id = $1 AND tenant_id = $2`, [parsed.data.device_group_id, auth.tenantId]);
  if (groupCheck.rows.length === 0) return reply.status(404).send({ error: "Host grubu bulunamadı" });

  const result = await pool.query(
    `INSERT INTO role_device_group_permissions (role_id, device_group_id, permission)
     VALUES ($1, $2, $3)
     ON CONFLICT (role_id, device_group_id) DO UPDATE SET permission = $3
     RETURNING id, device_group_id, permission`,
    [id, parsed.data.device_group_id, parsed.data.permission]
  );
  return reply.status(201).send(result.rows[0]);
});

app.delete("/api/v1/user-roles/:id/device-group-permissions/:permissionId", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canManageUsers) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { permissionId } = request.params as { permissionId: string };
  await pool.query(`DELETE FROM role_device_group_permissions WHERE id = $1`, [permissionId]);
  return reply.status(204).send();
});


// ============ ESCALATION STEPS (çok adımlı bildirim/otomatik müdahale) ============

const CreateEscalationStepSchema = z.object({
  step_order: z.number().min(1).default(1),
  delay_seconds: z.number().min(0).default(0),
  action_type: z.enum(["notify", "remote_command"]),
  media_type_id: z.string().uuid().optional(),
  remote_command: z.string().optional()
});

app.get("/api/v1/alert-template-rules/:id/escalation-steps", async (request) => {
  const { id } = request.params as { id: string };
  const result = await pool.query(
    `SELECT es.id, es.step_order, es.delay_seconds, es.action_type, es.media_type_id, es.remote_command, mt.name as media_type_name
     FROM escalation_steps es
     LEFT JOIN media_types mt ON mt.id = es.media_type_id
     WHERE es.alert_template_rule_id = $1 ORDER BY es.step_order`,
    [id]
  );
  return result.rows;
});

app.post("/api/v1/alert-template-rules/:id/escalation-steps", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  const parsed = CreateEscalationStepSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { step_order, delay_seconds, action_type, media_type_id, remote_command } = parsed.data;

  if (action_type === "notify" && !media_type_id) {
    return reply.status(400).send({ error: "notify tipi için media_type_id gerekli" });
  }
  if (action_type === "remote_command" && !remote_command) {
    return reply.status(400).send({ error: "remote_command tipi için remote_command gerekli" });
  }

  const result = await pool.query(
    `INSERT INTO escalation_steps (alert_template_rule_id, step_order, delay_seconds, action_type, media_type_id, remote_command)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, step_order, delay_seconds, action_type, media_type_id, remote_command`,
    [id, step_order, delay_seconds, action_type, media_type_id || null, remote_command || null]
  );
  return reply.status(201).send(result.rows[0]);
});

app.delete("/api/v1/escalation-steps/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditAlertRules) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM escalation_steps WHERE id = $1`, [id]);
  return reply.status(204).send();
});

// Internal servisler (Alarm Engine) için — bir alert_rule'ın (device'a kopyalanmış kuralın)
// bağlı olduğu template_rule'ın eskalasyon adımlarını döner.
app.get("/api/v1/internal/alert-rules/:id/escalation-steps", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const { id } = request.params as { id: string };
  const result = await pool.query(
    `SELECT es.step_order, es.delay_seconds, es.action_type, es.remote_command,
            mt.type as media_type, mt.config as media_type_config
     FROM alert_rules ar
     JOIN escalation_steps es ON es.alert_template_rule_id = ar.template_rule_id
     LEFT JOIN media_types mt ON mt.id = es.media_type_id
     WHERE ar.id = $1 ORDER BY es.step_order`,
    [id]
  );
  return result.rows;
});


// Alarm Engine'in eskalasyon adımı olarak tetiklediği uzak komutu Exec Collector'a iletir.
app.post("/api/v1/internal/trigger-remote-command", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const { device_id, command } = request.body as { device_id: string; command: string };
  const EXEC_COLLECTOR_URL = process.env.EXEC_COLLECTOR_URL || "http://exec-collector:3200";

  try {
    const response = await fetch(`${EXEC_COLLECTOR_URL}/trigger-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET || "" },
      body: JSON.stringify({ device_id, command })
    });
    const body = await response.json();
    return reply.status(response.status).send(body);
  } catch (err: any) {
    return reply.status(502).send({ error: `Exec Collector'a ulaşılamadı: ${err.message}` });
  }
});


// ============ DASHBOARDS & WIDGETS (kullanıcı özelleştirilebilir pano) ============

app.get("/api/v1/dashboards", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT id, name, is_shared, is_default, owner_user_id, created_at,
            default_device_id, default_device_group_id, default_hours
     FROM dashboards
     WHERE tenant_id = $1 AND (owner_user_id = $2 OR is_shared = true)
     ORDER BY is_default DESC, created_at`,
    [auth.tenantId, auth.userId]
  );
  return result.rows;
});

const CreateDashboardSchema = z.object({
  name: z.string().min(1),
  is_shared: z.boolean().default(false)
});

app.post("/api/v1/dashboards", async (request, reply) => {
  const auth = (request as any).auth;
  const parsed = CreateDashboardSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const result = await pool.query(
    `INSERT INTO dashboards (tenant_id, owner_user_id, name, is_shared) VALUES ($1, $2, $3, $4)
     RETURNING id, name, is_shared, is_default, owner_user_id, default_device_id, default_device_group_id, default_hours`,
    [auth.tenantId, auth.userId, parsed.data.name, parsed.data.is_shared]
  );
  return reply.status(201).send(result.rows[0]);
});

// Faz 9.4 + 9.8 + 9.10c: panonun varsayılan bağlamını (hangi cihaz/host grubu/zaman
// aralığı) ayarlar -- sadece pano sahibi değiştirebilir. Bu alanlar şu an için hiçbir
// widget tarafından OKUNMUYOR (Faz 9.5'in işi); burada sadece kalıcı hale getiriliyor.
const UpdateDashboardSchema = z.object({
  name: z.string().min(1).optional(),
  is_shared: z.boolean().optional(),
  default_device_id: z.string().uuid().nullable().optional(),
  default_device_group_id: z.string().uuid().nullable().optional(),
  default_hours: z.number().int().min(1).optional()
});

app.patch("/api/v1/dashboards/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  const parsed = UpdateDashboardSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { name, is_shared, default_device_id, default_device_group_id, default_hours } = parsed.data;

  if (default_device_id && !(await idBelongsToTenant("devices", default_device_id, auth.tenantId))) {
    return reply.status(404).send({ error: "Cihaz bulunamadı" });
  }
  if (default_device_group_id && !(await idBelongsToTenant("device_groups", default_device_group_id, auth.tenantId))) {
    return reply.status(404).send({ error: "Grup bulunamadı" });
  }

  const result = await pool.query(
    `UPDATE dashboards SET
       name = COALESCE($3, name),
       is_shared = COALESCE($4, is_shared),
       default_device_id = COALESCE($5, default_device_id),
       default_device_group_id = COALESCE($6, default_device_group_id),
       default_hours = COALESCE($7, default_hours)
     WHERE id = $1 AND tenant_id = $2 AND owner_user_id = $8
     RETURNING id, name, is_shared, is_default, owner_user_id, default_device_id, default_device_group_id, default_hours`,
    [id, auth.tenantId, name, is_shared, default_device_id, default_device_group_id, default_hours, auth.userId]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Pano bulunamadı ya da düzenleme yetkiniz yok" });
  return result.rows[0];
});

app.delete("/api/v1/dashboards/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM dashboards WHERE id = $1 AND tenant_id = $2 AND owner_user_id = $3`, [id, auth.tenantId, auth.userId]);
  return reply.status(204).send();
});

// GÜVENLİK: dashboard_id/widget_id UUID'sini bilen HERKES (başka tenant dahil) bu
// widget'ları okuyup/değiştirip/silebiliyordu — hiçbir tenant/sahiplik kontrolü yoktu.
// Aşağıdaki tüm endpoint'ler artık dashboards tablosuna JOIN ederek tenant_id + (owner_user_id
// ya da is_shared) doğrulaması yapıyor; yazma işlemleri (POST/PATCH/DELETE/PUT) sadece
// panonun SAHİBİNE izin veriyor (paylaşılan bir panoyu görüntüleyen başkası düzenleyemez).
app.get("/api/v1/dashboards/:id/widgets", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  const dashboardCheck = await pool.query(
    `SELECT id FROM dashboards WHERE id = $1 AND tenant_id = $2 AND (owner_user_id = $3 OR is_shared = true)`,
    [id, auth.tenantId, auth.userId]
  );
  if (dashboardCheck.rows.length === 0) return reply.status(404).send({ error: "Pano bulunamadı" });

  const result = await pool.query(
    `SELECT id, widget_type, position_x, position_y, width, height, title, config
     FROM dashboard_widgets WHERE dashboard_id = $1`,
    [id]
  );
  return result.rows;
});

const CreateWidgetSchema = z.object({
  widget_type: z.enum([
    "graph", "problem_list", "device_status", "kpi_card",
    "severity_distribution", "problem_devices", "top_n", "platform_summary",
    "service_health", "escalation_history", "maintenance_windows",
    "device_card", "status_badge", "raw_table", "note", "clock", "url", "gauge", "pie_chart",
    "device_explorer", "status_grid", "web_monitoring_summary", "host_performance_table"
  ]),
  position_x: z.number().default(0),
  position_y: z.number().default(0),
  width: z.number().default(4),
  height: z.number().default(3),
  title: z.string().optional(),
  config: z.record(z.any()).default({})
});

app.post("/api/v1/dashboards/:id/widgets", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  const parsed = CreateWidgetSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { widget_type, position_x, position_y, width, height, title, config } = parsed.data;

  const dashboardCheck = await pool.query(
    `SELECT id FROM dashboards WHERE id = $1 AND tenant_id = $2 AND owner_user_id = $3`,
    [id, auth.tenantId, auth.userId]
  );
  if (dashboardCheck.rows.length === 0) return reply.status(404).send({ error: "Pano bulunamadı ya da düzenleme yetkiniz yok" });

  const result = await pool.query(
    `INSERT INTO dashboard_widgets (dashboard_id, widget_type, position_x, position_y, width, height, title, config)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, widget_type, position_x, position_y, width, height, title, config`,
    [id, widget_type, position_x, position_y, width, height, title || null, JSON.stringify(config)]
  );
  return reply.status(201).send(result.rows[0]);
});

const UpdateWidgetSchema = z.object({
  position_x: z.number().optional(),
  position_y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  title: z.string().nullable().optional(),
  config: z.record(z.any()).optional()
});

app.patch("/api/v1/dashboard-widgets/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  const parsed = UpdateWidgetSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { position_x, position_y, width, height, title, config } = parsed.data;

  const result = await pool.query(
    `UPDATE dashboard_widgets AS dw SET
       position_x = COALESCE($2, dw.position_x),
       position_y = COALESCE($3, dw.position_y),
       width = COALESCE($4, dw.width),
       height = COALESCE($5, dw.height),
       title = COALESCE($6, dw.title),
       config = COALESCE($7, dw.config)
     FROM dashboards d
     WHERE dw.id = $1 AND dw.dashboard_id = d.id AND d.tenant_id = $8 AND d.owner_user_id = $9
     RETURNING dw.id, dw.widget_type, dw.position_x, dw.position_y, dw.width, dw.height, dw.title, dw.config`,
    [id, position_x, position_y, width, height, title, config ? JSON.stringify(config) : null, auth.tenantId, auth.userId]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Widget bulunamadı ya da düzenleme yetkiniz yok" });
  return result.rows[0];
});

app.delete("/api/v1/dashboard-widgets/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  await pool.query(
    `DELETE FROM dashboard_widgets dw USING dashboards d
     WHERE dw.id = $1 AND dw.dashboard_id = d.id AND d.tenant_id = $2 AND d.owner_user_id = $3`,
    [id, auth.tenantId, auth.userId]
  );
  return reply.status(204).send();
});

// Toplu widget kaydetme (madde 9.6 + 9.10a) — Dashboard'un Düzenleme Modu, sürükleme/
// boyutlandırma/ekleme/silme işlemlerini yerel state'te biriktirir, sadece "Kaydet"e
// basınca burada TEK bir transaction'da uygulanır: gönderilen listede id'si OLMAYAN
// widget'lar yeni eklenir, id'si OLAN'lar güncellenir, listede hiç YER ALMAYAN (yani
// kullanıcının sildiği) mevcut widget'lar silinir. "Vazgeç" hiç bu endpoint'e uğramaz.
const BulkWidgetSchema = z.object({
  id: z.string().uuid().optional(),
  widget_type: z.enum([
    "graph", "problem_list", "device_status", "kpi_card",
    "severity_distribution", "problem_devices", "top_n", "platform_summary",
    "service_health", "escalation_history", "maintenance_windows",
    "device_card", "status_badge", "raw_table", "note", "clock", "url", "gauge", "pie_chart",
    "device_explorer", "status_grid", "web_monitoring_summary", "host_performance_table"
  ]),
  position_x: z.number().int().min(0),
  position_y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  title: z.string().nullable().optional(),
  config: z.record(z.any()).default({})
});

const BulkUpdateWidgetsSchema = z.object({
  widgets: z.array(BulkWidgetSchema)
});

app.put("/api/v1/dashboards/:id/widgets", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  const parsed = BulkUpdateWidgetsSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const dashboardCheck = await pool.query(
    `SELECT id FROM dashboards WHERE id = $1 AND tenant_id = $2 AND owner_user_id = $3`,
    [id, auth.tenantId, auth.userId]
  );
  if (dashboardCheck.rows.length === 0) return reply.status(404).send({ error: "Pano bulunamadı ya da düzenleme yetkiniz yok" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const incomingIds = parsed.data.widgets.filter((w) => w.id).map((w) => w.id) as string[];
    if (incomingIds.length > 0) {
      await client.query(`DELETE FROM dashboard_widgets WHERE dashboard_id = $1 AND id != ALL($2::uuid[])`, [id, incomingIds]);
    } else {
      await client.query(`DELETE FROM dashboard_widgets WHERE dashboard_id = $1`, [id]);
    }

    const saved: any[] = [];
    for (const w of parsed.data.widgets) {
      if (w.id) {
        const updated = await client.query(
          `UPDATE dashboard_widgets SET
             widget_type = $3, position_x = $4, position_y = $5, width = $6, height = $7, title = $8, config = $9
           WHERE id = $1 AND dashboard_id = $2
           RETURNING id, widget_type, position_x, position_y, width, height, title, config`,
          [w.id, id, w.widget_type, w.position_x, w.position_y, w.width, w.height, w.title || null, JSON.stringify(w.config)]
        );
        if (updated.rows.length > 0) saved.push(updated.rows[0]);
      } else {
        const inserted = await client.query(
          `INSERT INTO dashboard_widgets (dashboard_id, widget_type, position_x, position_y, width, height, title, config)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, widget_type, position_x, position_y, width, height, title, config`,
          [id, w.widget_type, w.position_x, w.position_y, w.width, w.height, w.title || null, JSON.stringify(w.config)]
        );
        saved.push(inserted.rows[0]);
      }
    }

    await client.query("COMMIT");
    return saved;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// KPI kartı için hazır sayılar
app.get("/api/v1/dashboard-kpi/:source", async (request, reply) => {
  const auth = (request as any).auth;
  const { source } = request.params as { source: string };

  if (source === "open_alerts") {
    const result = await pool.query(`SELECT COUNT(*)::int as value FROM alerts WHERE tenant_id = $1 AND resolved_at IS NULL`, [auth.tenantId]);
    return { value: result.rows[0].value };
  }
  if (source === "active_devices") {
    const result = await pool.query(`SELECT COUNT(*)::int as value FROM devices WHERE tenant_id = $1 AND status = 'active'`, [auth.tenantId]);
    return { value: result.rows[0].value };
  }
  if (source === "total_devices") {
    const result = await pool.query(`SELECT COUNT(*)::int as value FROM devices WHERE tenant_id = $1`, [auth.tenantId]);
    return { value: result.rows[0].value };
  }
  return reply.status(400).send({ error: "Bilinmeyen KPI kaynağı" });
});


// ============ EK WIDGET VERİ ENDPOINT'LERİ (9.3) ============

// Severity Dağılımı — açık alarmların önem derecesine göre sayısı
app.get("/api/v1/dashboard-widgets-data/severity-distribution", async (request) => {
  const auth = (request as any).auth;
  const query = request.query as { device_group_id?: string };

  let sql = `SELECT a.severity, COUNT(*)::int as count FROM alerts a WHERE a.tenant_id = $1 AND a.resolved_at IS NULL`;
  const params: any[] = [auth.tenantId];

  if (query.device_group_id) {
    sql += ` AND a.device_id IN (SELECT device_id FROM device_group_members WHERE device_group_id = $2)`;
    params.push(query.device_group_id);
  }
  sql += ` GROUP BY a.severity`;

  const result = await pool.query(sql, params);
  return result.rows;
});

// Alarmlı Cihazlar — hangi cihazlarda açık alarm var
app.get("/api/v1/dashboard-widgets-data/problem-devices", async (request) => {
  const auth = (request as any).auth;
  const query = request.query as { device_group_id?: string; limit?: string };
  const limit = Math.min(Number(query.limit) || 10, 50);

  let sql = `
    SELECT d.id, d.name, COUNT(a.id)::int as alert_count, MAX(a.severity) as max_severity
    FROM devices d
    JOIN alerts a ON a.device_id = d.id AND a.resolved_at IS NULL
    WHERE d.tenant_id = $1`;
  const params: any[] = [auth.tenantId];

  if (query.device_group_id) {
    sql += ` AND d.id IN (SELECT device_id FROM device_group_members WHERE device_group_id = $2)`;
    params.push(query.device_group_id);
  }
  sql += ` GROUP BY d.id ORDER BY alert_count DESC LIMIT ${limit}`;

  const result = await pool.query(sql, params);
  return result.rows;
});

// Top N — bir metriğin en yüksek/düşük N cihazı
app.get("/api/v1/dashboard-widgets-data/top-n", async (request, reply) => {
  const auth = (request as any).auth;
  const query = request.query as { metric_name?: string; device_group_id?: string; limit?: string; order?: string };
  if (!query.metric_name) return reply.status(400).send({ error: "metric_name gerekli" });

  const limit = Math.min(Number(query.limit) || 5, 20);
  const order = query.order === "asc" ? "ASC" : "DESC";

  let sql = `
    SELECT DISTINCT ON (d.id) d.id, d.name, m.value, m.time
    FROM devices d
    JOIN metrics m ON m.device_id = d.id
    WHERE d.tenant_id = $1 AND m.metric_name = $2`;
  const params: any[] = [auth.tenantId, query.metric_name];

  if (query.device_group_id) {
    sql += ` AND d.id IN (SELECT device_id FROM device_group_members WHERE device_group_id = $3)`;
    params.push(query.device_group_id);
  }
  sql += ` ORDER BY d.id, m.time DESC`;

  const inner = await pool.query(sql, params);
  const sorted = inner.rows.sort((a, b) => order === "ASC" ? a.value - b.value : b.value - a.value).slice(0, limit);
  return sorted;
});

// Durum Izgarası (Faz 10.6) — bir metriği TÜM cihazlarda (host grubu bazlı
// filtrelenebilir) tek bakışta gösterir; eşik/value_map renklendirmesi frontend'de
// yapılır, burada sadece her cihazın o metriğin en son değeri döner.
app.get("/api/v1/dashboard-widgets-data/status-grid", async (request, reply) => {
  const auth = (request as any).auth;
  const query = request.query as { metric_name?: string; device_group_id?: string };
  if (!query.metric_name) return reply.status(400).send({ error: "metric_name gerekli" });

  let sql = `
    SELECT DISTINCT ON (d.id) d.id, d.name, m.value, m.time
    FROM devices d
    JOIN metrics m ON m.device_id = d.id
    WHERE d.tenant_id = $1 AND m.metric_name = $2`;
  const params: any[] = [auth.tenantId, query.metric_name];

  if (query.device_group_id) {
    sql += ` AND d.id IN (SELECT device_id FROM device_group_members WHERE device_group_id = $3)`;
    params.push(query.device_group_id);
  }
  sql += ` ORDER BY d.id, m.time DESC`;

  const result = await pool.query(sql, params);
  return result.rows;
});

// Servis Sağlığı — bir Web Scenario'nun son durumu + gecikmesi
app.get("/api/v1/dashboard-widgets-data/service-health/:scenarioId", async (request, reply) => {
  const auth = (request as any).auth;
  const { scenarioId } = request.params as { scenarioId: string };

  const scenarioResult = await pool.query(
    `SELECT ws.id, ws.name FROM web_scenarios ws
     JOIN alert_templates t ON t.id = ws.template_id
     WHERE ws.id = $1 AND t.tenant_id = $2`,
    [scenarioId, auth.tenantId]
  );
  if (scenarioResult.rows.length === 0) return reply.status(404).send({ error: "Senaryo bulunamadı" });

  const stepsResult = await pool.query(`SELECT name FROM web_scenario_steps WHERE scenario_id = $1 ORDER BY step_order`, [scenarioId]);

  const results = [];
  for (const step of stepsResult.rows) {
    const prefix = `web_${scenarioResult.rows[0].name.replace(/\s+/g, "_")}_${step.name.replace(/\s+/g, "_")}`;
    const statusResult = await pool.query(
      `SELECT value, time FROM metrics WHERE metric_name = $1 AND tenant_id = $2 ORDER BY time DESC LIMIT 1`,
      [`${prefix}_status`, auth.tenantId]
    );
    const latencyResult = await pool.query(
      `SELECT value FROM metrics WHERE metric_name = $1 AND tenant_id = $2 ORDER BY time DESC LIMIT 1`,
      [`${prefix}_response_time_ms`, auth.tenantId]
    );
    results.push({
      step_name: step.name,
      status: statusResult.rows[0]?.value ?? null,
      latency_ms: latencyResult.rows[0]?.value ?? null,
      last_check: statusResult.rows[0]?.time ?? null
    });
  }
  return { scenario_name: scenarioResult.rows[0].name, steps: results };
});

// Web İzleme Özeti (Faz 10.3) — TÜM web senaryolarının step'lerini tarayıp
// Ok/Failed/Unknown sayar. scenarioRunner.ts zaten her step için temiz bir boolean
// {prefix}_status metriği (1=basari, 0=basarisiz, expected_status_code'a tam eslesmeye
// gore) yayinladigi icin HTTP kod araligini burada yeniden yorumlamaya hic gerek yok --
// service-health endpoint'iyle AYNI metric_name yeniden insa mantigini kullaniyoruz.
app.get("/api/v1/dashboard-widgets-data/web-monitoring-summary", async (request) => {
  const auth = (request as any).auth;

  const scenariosResult = await pool.query(
    `SELECT ws.id, ws.name FROM web_scenarios ws
     JOIN alert_templates t ON t.id = ws.template_id
     WHERE t.tenant_id = $1`,
    [auth.tenantId]
  );

  const results = [];
  for (const scenario of scenariosResult.rows) {
    const stepsResult = await pool.query(`SELECT name FROM web_scenario_steps WHERE scenario_id = $1`, [scenario.id]);
    let ok = 0, failed = 0, unknown = 0;
    for (const step of stepsResult.rows) {
      const prefix = `web_${scenario.name.replace(/\s+/g, "_")}_${step.name.replace(/\s+/g, "_")}`;
      const statusResult = await pool.query(
        `SELECT value FROM metrics WHERE metric_name = $1 AND tenant_id = $2 ORDER BY time DESC LIMIT 1`,
        [`${prefix}_status`, auth.tenantId]
      );
      if (statusResult.rows.length === 0) unknown++;
      else if (Number(statusResult.rows[0].value) === 1) ok++;
      else failed++;
    }
    results.push({ scenario_id: scenario.id, scenario_name: scenario.name, ok_count: ok, failed_count: failed, unknown_count: unknown });
  }
  return results;
});

// Host Performans Tablosu (Faz 10.7) -- birden fazla cihazin birden fazla metrigini
// tek tabloda, her hucrede mini sparkline verisiyle doner. Performans korumasi icin
// SERT ust sinirlar var: en fazla 25 cihaz, en fazla 5 metrik, en fazla 30 nokta --
// device_group_id filtresi VERILMEZSE tum cihazlar taranir (25 sinirina kadar), bu
// yuzden host grubu filtresi kullanicilar tarafindan siddetle tavsiye edilir ama
// zorunlu tutulmuyor.
app.get("/api/v1/dashboard-widgets-data/host-performance-table", async (request, reply) => {
  const auth = (request as any).auth;
  const query = request.query as { device_group_id?: string; metrics?: string; sparkline_points?: string };
  if (!query.metrics) return reply.status(400).send({ error: "metrics gerekli (virgülle ayrılmış metrik adları)" });

  const metricNames = query.metrics.split(",").map((m) => m.trim()).filter(Boolean).slice(0, 5);
  const points = Math.min(Number(query.sparkline_points) || 20, 30);

  let deviceSql = `SELECT id, name FROM devices WHERE tenant_id = $1`;
  const deviceParams: any[] = [auth.tenantId];
  if (query.device_group_id) {
    deviceSql += ` AND id IN (SELECT device_id FROM device_group_members WHERE device_group_id = $2)`;
    deviceParams.push(query.device_group_id);
  }
  deviceSql += ` ORDER BY name LIMIT 25`;
  const devicesResult = await pool.query(deviceSql, deviceParams);

  const results = [];
  for (const device of devicesResult.rows) {
    const series: Record<string, any[]> = {};
    const latest: Record<string, number | null> = {};
    for (const metricName of metricNames) {
      const rowsResult = await pool.query(
        `SELECT time, value FROM metrics WHERE tenant_id = $1 AND device_id = $2 AND metric_name = $3
         ORDER BY time DESC LIMIT $4`,
        [auth.tenantId, device.id, metricName, points]
      );
      const rows = rowsResult.rows.reverse();
      series[metricName] = rows;
      latest[metricName] = rows.length > 0 ? Number(rows[rows.length - 1].value) : null;
    }
    results.push({ device_id: device.id, device_name: device.name, series, latest });
  }
  return results;
});

// Eskalasyon Geçmişi — son tetiklenen eskalasyon adımları (audit_log üzerinden değil,
// alerts.last_escalation_step değişimini doğrudan gösteremediğimiz için basitleştirilmiş:
// son güncellenen (last_escalation_step > 0) alarmları listeler)
app.get("/api/v1/dashboard-widgets-data/escalation-history", async (request) => {
  const auth = (request as any).auth;
  const query = request.query as { limit?: string };
  const limit = Math.min(Number(query.limit) || 10, 50);

  const result = await pool.query(
    `SELECT a.id, a.metric_name, a.last_escalation_step, a.triggered_at, d.name as device_name
     FROM alerts a
     JOIN devices d ON d.id = a.device_id
     WHERE a.tenant_id = $1 AND a.last_escalation_step > 0
     ORDER BY a.triggered_at DESC LIMIT ${limit}`,
    [auth.tenantId]
  );
  return result.rows;
});

// Platform Özeti — genel sayılar
app.get("/api/v1/dashboard-widgets-data/platform-summary", async (request) => {
  const auth = (request as any).auth;
  const [deviceStats, templates, ruleStats, openAlerts, activeMetrics, userCount, throughput] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int as total,
              COUNT(*) FILTER (WHERE status = 'active')::int as active,
              COUNT(*) FILTER (WHERE status = 'down')::int as down
       FROM devices WHERE tenant_id = $1`,
      [auth.tenantId]
    ),
    pool.query(`SELECT COUNT(*)::int as c FROM alert_templates WHERE tenant_id = $1`, [auth.tenantId]),
    pool.query(
      `SELECT COUNT(*)::int as total,
              COUNT(*) FILTER (WHERE active)::int as active,
              COUNT(*) FILTER (WHERE NOT active)::int as inactive
       FROM alert_rules WHERE tenant_id = $1`,
      [auth.tenantId]
    ),
    pool.query(`SELECT COUNT(*)::int as c FROM alerts WHERE tenant_id = $1 AND resolved_at IS NULL`, [auth.tenantId]),
    // Faz 10.5 -- template_items'ta "aktif/pasif" kavramı yok (tanımlıysa hep gecerlidir),
    // bu yuzden "metrik sayisi" olarak SON 24 SAATTE GERCEKTEN VERI URETEN benzersiz
    // metric_name sayisini kullaniyoruz -- statik bir tanim sayisindan daha anlamli.
    pool.query(
      `SELECT COUNT(DISTINCT metric_name)::int as c FROM metrics WHERE tenant_id = $1 AND time >= now() - interval '24 hours'`,
      [auth.tenantId]
    ),
    // "Cevrimici kullanici" bizde TAKIP EDILMIYOR (JWT session, sunucu tarafi presence yok)
    // -- sahte bir sayi uydurmak yerine durustce TOPLAM KAYITLI kullanici sayisini gosteriyoruz.
    pool.query(`SELECT COUNT(*)::int as c FROM users WHERE tenant_id = $1`, [auth.tenantId]),
    pool.query(
      `SELECT COUNT(*)::int as c FROM metrics WHERE tenant_id = $1 AND time >= now() - interval '60 seconds'`,
      [auth.tenantId]
    )
  ]);
  return {
    device_count: deviceStats.rows[0].total,
    device_active: deviceStats.rows[0].active,
    device_down: deviceStats.rows[0].down,
    template_count: templates.rows[0].c,
    active_rule_count: ruleStats.rows[0].active,
    rule_count: ruleStats.rows[0].total,
    inactive_rule_count: ruleStats.rows[0].inactive,
    open_alert_count: openAlerts.rows[0].c,
    active_metric_count: activeMetrics.rows[0].c,
    user_count: userCount.rows[0].c,
    metrics_per_second: Math.round((throughput.rows[0].c / 60) * 100) / 100
  };
});

// Bakım Pencereleri — aktif/yaklaşan
app.get("/api/v1/dashboard-widgets-data/maintenance-windows", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT id, name, starts_at, ends_at, (starts_at <= now() AND ends_at >= now()) as is_active
     FROM maintenance_windows WHERE tenant_id = $1 AND ends_at >= now()
     ORDER BY starts_at LIMIT 10`,
    [auth.tenantId]
  );
  return result.rows;
});


// ============ EK WIDGET VERİ ENDPOINT'LERİ (9.3 devamı) ============

// Cihaz Kartı — tek cihazın özet bilgisi
app.get("/api/v1/dashboard-widgets-data/device-card/:deviceId", async (request, reply) => {
  const auth = (request as any).auth;
  const { deviceId } = request.params as { deviceId: string };

  const deviceResult = await pool.query(
    `SELECT id, name, ip_address, device_type, vendor, status FROM devices WHERE id = $1 AND tenant_id = $2`,
    [deviceId, auth.tenantId]
  );
  if (deviceResult.rows.length === 0) return reply.status(404).send({ error: "Cihaz bulunamadı" });

  const alertResult = await pool.query(
    `SELECT COUNT(*)::int as c FROM alerts WHERE device_id = $1 AND resolved_at IS NULL`,
    [deviceId]
  );
  const templateResult = await pool.query(
    `SELECT t.name FROM device_templates dt JOIN alert_templates t ON t.id = dt.template_id WHERE dt.device_id = $1`,
    [deviceId]
  );

  return { ...deviceResult.rows[0], open_alert_count: alertResult.rows[0].c, templates: templateResult.rows.map((r) => r.name) };
});

// Durum Rozeti — value_map'li tek bir metriğin anlık durumu
app.get("/api/v1/dashboard-widgets-data/status-badge", async (request, reply) => {
  const auth = (request as any).auth;
  const query = request.query as { device_id?: string; metric_name?: string };
  if (!query.device_id || !query.metric_name) return reply.status(400).send({ error: "device_id ve metric_name gerekli" });

  const metricResult = await pool.query(
    `SELECT value, time FROM metrics WHERE device_id = $1 AND metric_name = $2 AND tenant_id = $3 ORDER BY time DESC LIMIT 1`,
    [query.device_id, query.metric_name, auth.tenantId]
  );
  if (metricResult.rows.length === 0) return { value: null, label: null, time: null };

  const itemResult = await pool.query(
    `SELECT vm.mappings FROM template_items ti
     JOIN value_maps vm ON vm.id = ti.value_map_id
     JOIN device_templates dt ON dt.template_id = ti.template_id
     WHERE dt.device_id = $1 AND ti.metric_name = $2 LIMIT 1`,
    [query.device_id, query.metric_name]
  );

  const rawValue = metricResult.rows[0].value;
  let label = String(rawValue);
  if (itemResult.rows.length > 0) {
    const mapping = itemResult.rows[0].mappings.find((m: any) => m.value === String(rawValue));
    if (mapping) label = mapping.label;
  }

  return { value: rawValue, label, time: metricResult.rows[0].time };
});

// Ham Tablo — is_table verisinin satır satır dökümü
app.get("/api/v1/dashboard-widgets-data/raw-table", async (request, reply) => {
  const auth = (request as any).auth;
  const query = request.query as { device_id?: string; metric_name?: string };
  if (!query.device_id || !query.metric_name) return reply.status(400).send({ error: "device_id ve metric_name gerekli" });

  const result = await pool.query(
    `SELECT DISTINCT ON (interface) interface, value, time FROM metrics
     WHERE device_id = $1 AND metric_name = $2 AND tenant_id = $3
     ORDER BY interface, time DESC`,
    [query.device_id, query.metric_name, auth.tenantId]
  );
  return result.rows;
});


// ============ TOPOLOGY POSITIONS (8.5 — sürüklenebilir düğüm konumları + alarm durumu) ============

app.get("/api/v1/topology/full", async (request) => {
  const auth = (request as any).auth;

  const devicesResult = await pool.query(
    `SELECT d.id, d.name, d.device_type, d.status,
            COALESCE(tp.x, 0) as x, COALESCE(tp.y, 0) as y,
            (SELECT COUNT(*)::int FROM alerts a WHERE a.device_id = d.id AND a.resolved_at IS NULL) as open_alert_count,
            (SELECT MAX(a.severity) FROM alerts a WHERE a.device_id = d.id AND a.resolved_at IS NULL) as max_severity
     FROM devices d
     LEFT JOIN topology_positions tp ON tp.device_id = d.id AND tp.tenant_id = $1
     WHERE d.tenant_id = $1`,
    [auth.tenantId]
  );

  const linksResult = await pool.query(
    `SELECT id, device_a_id, device_b_id, interface_a, interface_b FROM device_links WHERE tenant_id = $1`,
    [auth.tenantId]
  );

  return { devices: devicesResult.rows, links: linksResult.rows };
});

const SaveTopologyPositionsSchema = z.object({
  positions: z.array(z.object({ device_id: z.string().uuid(), x: z.number(), y: z.number() }))
});

app.put("/api/v1/topology/positions", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditDevices) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const parsed = SaveTopologyPositionsSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const pos of parsed.data.positions) {
      // Cihazın gerçekten bu tenant'a ait olduğunu doğrula (cross-tenant koruması)
      const ownCheck = await client.query(`SELECT id FROM devices WHERE id = $1 AND tenant_id = $2`, [pos.device_id, auth.tenantId]);
      if (ownCheck.rows.length === 0) continue;

      await client.query(
        `INSERT INTO topology_positions (tenant_id, device_id, x, y) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, device_id) DO UPDATE SET x = $3, y = $4`,
        [auth.tenantId, pos.device_id, pos.x, pos.y]
      );
    }
    await client.query("COMMIT");
    return { success: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});


// ============ DEVICE COLLECTOR STATUS (her collector tipi için ayrı erişilebilirlik) ============

// Internal — collector servisleri (NPM, Exec, SQL, Web) kendi durumlarını buradan yazar.
app.post("/api/v1/internal/devices/:id/collector-status", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });
  const { id } = request.params as { id: string };
  const { collector_type, status, error } = request.body as { collector_type: string; status: "active" | "down"; error?: string };

  // GERCEK EKSIKLIK DUZELTMESI: exec/sql/web collector'lari TEK bir hatada HEMEN
  // 'down' raporluyordu -- SNMP'nin (npm-service) FAILURE_THRESHOLD/SUCCESS_THRESHOLD
  // mantigi burada HIC yoktu. Gecici bir ag gecikmesi/timeout bile aninda bir
  // 'device_reachability' alarmi tetikleyebiliyordu. Burada da AYNI simetrik esik
  // (2 ardisik basarisizlik -> down, TEK bir basari -> hemen active) uygulaniyor --
  // bu, TUM collector tiplerinin (exec/sql/web) ORTAK yazma noktasi oldugu icin,
  // her birini AYRI AYRI degistirmeye gerek kalmadan hepsini duzeltir.
  const FAILURE_THRESHOLD = 2;
  const existing = await pool.query(
    `SELECT status, consecutive_failures FROM device_collector_status WHERE device_id = $1 AND collector_type = $2`,
    [id, collector_type]
  );
  const prevStatus: string = existing.rows[0]?.status ?? "active";
  const prevFailures: number = existing.rows[0]?.consecutive_failures ?? 0;

  let consecutiveFailures: number;
  let effectiveStatus: "active" | "down";
  if (status === "active") {
    consecutiveFailures = 0;
    effectiveStatus = "active";
  } else {
    consecutiveFailures = prevFailures + 1;
    effectiveStatus = consecutiveFailures >= FAILURE_THRESHOLD ? "down" : (prevStatus as "active" | "down");
  }

  await pool.query(
    `INSERT INTO device_collector_status (device_id, collector_type, status, last_checked_at, last_error, consecutive_failures)
     VALUES ($1, $2, $3, now(), $4, $5)
     ON CONFLICT (device_id, collector_type) DO UPDATE SET status = $3, last_checked_at = now(), last_error = $4, consecutive_failures = $5`,
    [id, collector_type, effectiveStatus, error || null, consecutiveFailures]
  );
  // devices.status'u da türet: en az bir collector active ise active, hepsi down ise down.
  const allStatuses = await pool.query(`SELECT status FROM device_collector_status WHERE device_id = $1`, [id]);
  const hasActive = allStatuses.rows.some((r) => r.status === "active");
  const derivedStatus = hasActive ? "active" : "down";
  await pool.query(`UPDATE devices SET status = $1 WHERE id = $2`, [derivedStatus, id]);
  return reply.status(204).send();
});

// Cihazın her collector tipi için ayrı durumunu döner (host listesi "Availability" sütunu için).
app.get("/api/v1/devices/:id/collector-status", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("devices", id, auth.tenantId))) return reply.status(404).send({ error: "Cihaz bulunamadı" });

  const result = await pool.query(
    `SELECT collector_type, status, last_checked_at, last_error FROM device_collector_status WHERE device_id = $1`,
    [id]
  );
  return result.rows;
});

// Tüm cihazların collector durumlarını tek seferde döner (liste sayfası için, N+1 önler).
app.get("/api/v1/devices-collector-status", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT dcs.device_id, dcs.collector_type, dcs.status
     FROM device_collector_status dcs
     JOIN devices d ON d.id = dcs.device_id
     WHERE d.tenant_id = $1`,
    [auth.tenantId]
  );
  return result.rows;
});


// ============ DEVICE INTERFACES (Zabbix'in çoklu-interface modeli — snmp/ssh/sql/web) ============

const DeviceInterfaceSchema = z.object({
  interface_type: z.enum(["snmp", "ssh", "sql", "web"]),
  ip_address: z.string().optional(),
  port: z.number().optional(),
  snmp_community: z.string().optional()
});

app.get("/api/v1/devices/:id/interfaces", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("devices", id, auth.tenantId))) return reply.status(404).send({ error: "Cihaz bulunamadı" });

  const result = await pool.query(
    `SELECT id, interface_type, ip_address, port, snmp_community FROM device_interfaces WHERE device_id = $1`,
    [id]
  );
  return result.rows;
});

app.put("/api/v1/devices/:id/interfaces", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("devices", id, auth.tenantId))) return reply.status(404).send({ error: "Cihaz bulunamadı" });

  const parsed = z.object({ interfaces: z.array(DeviceInterfaceSchema) }).safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM device_interfaces WHERE device_id = $1`, [id]);
    for (const iface of parsed.data.interfaces) {
      if (!iface.ip_address) continue; // boş IP'li interface kaydedilmez
      await client.query(
        `INSERT INTO device_interfaces (device_id, interface_type, ip_address, port, snmp_community) VALUES ($1, $2, $3, $4, $5)`,
        [id, iface.interface_type, iface.ip_address, iface.port || null, iface.snmp_community || null]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const result = await pool.query(`SELECT id, interface_type, ip_address, port, snmp_community FROM device_interfaces WHERE device_id = $1`, [id]);
  return result.rows;
});

// Internal — collector servislerinin cihazın kendi collector tipine ait interface'ini çekmesi için.
app.get("/api/v1/internal/devices/:id/interface/:type", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const { id, type } = request.params as { id: string; type: string };
  const result = await pool.query(
    `SELECT ip_address, port, snmp_community FROM device_interfaces WHERE device_id = $1 AND interface_type = $2`,
    [id, type]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Interface tanımlı değil" });
  return result.rows[0];
});


// ============ FAZ E — AGENT TABANLI TOPLAMA (5. collector tipi, push modeli) ============

// Tenant-seviyesinde agent kayıt token'ı yönetimi (mevcut API Token deseniyle aynı).
app.get("/api/v1/agent-registration-tokens", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT id, name, expires_at, revoked_at, created_at FROM agent_registration_tokens
     WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [auth.tenantId]
  );
  return result.rows;
});

app.post("/api/v1/agent-registration-tokens", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditDevices) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const parsed = z.object({ name: z.string().min(1) }).safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const { rawToken, tokenHash } = generateRegistrationToken();
  const result = await pool.query(
    `INSERT INTO agent_registration_tokens (tenant_id, name, token_hash) VALUES ($1, $2, $3)
     RETURNING id, name, created_at`,
    [auth.tenantId, parsed.data.name, tokenHash]
  );
  // Ham token SADECE burada, bir kez gösterilir.
  return reply.status(201).send({ ...result.rows[0], token: rawToken });
});

app.delete("/api/v1/agent-registration-tokens/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditDevices) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`UPDATE agent_registration_tokens SET revoked_at = now() WHERE id = $1 AND tenant_id = $2`, [id, auth.tenantId]);
  return reply.status(204).send();
});

// Agent'ın ilk çalıştırmada kendi kendine cihaz olarak kaydolması. HostMetadata (Zabbix'in
// otomatik kayıt mekanizmasındaki gibi) opsiyonel — ileride otomatik grup/template ataması
// için kullanılabilir, şimdilik sadece attributes'a kaydediliyor.
const AgentRegisterSchema = z.object({
  registration_token: z.string(),
  hostname: z.string().min(1),
  host_metadata: z.string().optional(),
  ip_address: z.string().optional() // agent'ın kendi tespit ettiği yerel IP'si -- boşsa isteğin geldiği IP kullanılır
});

app.post("/api/v1/agent/register", async (request, reply) => {
  const parsed = AgentRegisterSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const tokenHash = hashRegistrationToken(parsed.data.registration_token);
  const tokenResult = await pool.query(
    `SELECT id, tenant_id FROM agent_registration_tokens WHERE token_hash = $1 AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at > now())`,
    [tokenHash]
  );
  if (tokenResult.rows.length === 0) return reply.status(401).send({ error: "Geçersiz veya süresi dolmuş kayıt token'ı" });
  const tenantId = tokenResult.rows[0].tenant_id;

  const { rawPsk, pskHash } = generateDevicePsk();

  // Aynı hostname ile daha önce kayıt olunmuşsa, yeni PSK üretip mevcut cihazı güncelle
  // (agent'ın yeniden kurulması/PSK kaybı senaryosu) — aksi halde uq_devices_tenant_name çakışır.
  // GERCEK EKSIKLIK DUZELTMESI: IP adresi daha once SABIT '0.0.0.0' yaziliyordu --
  // ne agent kendi IP'sini bildiriyordu ne sunucu istegin geldigi IP'yi kullaniyordu.
  // Oncelik: agent'in kendi bildirdigi ip_address (kendi yerel IP'sini dogru bilir,
  // proxy/gateway karmasikligindan bagimsizdir) -- o yoksa istegin geldigi gercek IP
  // (request.ip) fallback olarak kullanilir, '0.0.0.0' SADECE ikisi de yoksa kalir.
  const resolvedIp = parsed.data.ip_address || request.ip || "0.0.0.0";

  const existing = await pool.query(`SELECT id FROM devices WHERE tenant_id = $1 AND name = $2`, [tenantId, parsed.data.hostname]);

  let deviceId: string;
  if (existing.rows.length > 0) {
    deviceId = existing.rows[0].id;
    await pool.query(`UPDATE devices SET agent_psk = $1, ip_address = $2, last_agent_checkin = now() WHERE id = $3`, [pskHash, resolvedIp, deviceId]);
  } else {
    const inserted = await pool.query(
      `INSERT INTO devices (tenant_id, name, ip_address, device_type, status, agent_psk, attributes)
       VALUES ($1, $2, $3, 'server', 'unknown', $4, $5) RETURNING id`,
      [tenantId, parsed.data.hostname, resolvedIp, pskHash, JSON.stringify({ host_metadata: parsed.data.host_metadata || null, registered_via: "agent" })]
    );
    deviceId = inserted.rows[0].id;
  }

  return reply.status(201).send({ device_id: deviceId, psk: rawPsk });
});

// Agent PSK doğrulama yardımcısı — sonraki 3 endpoint'te ortak kullanılır.
async function authenticateAgent(deviceId: string, psk: string): Promise<boolean> {
  const pskHash = hashDevicePsk(psk);
  const result = await pool.query(`SELECT id FROM devices WHERE id = $1 AND agent_psk = $2`, [deviceId, pskHash]);
  return result.rows.length > 0;
}

// Agent'ın periyodik (RefreshActiveChecks, varsayılan 120sn) olarak "hangi item'ları
// toplamalıyım" diye sorduğu endpoint — mevcut effective-items mantığını agent tipine uyarlar.
app.get("/api/v1/agent/items", async (request, reply) => {
  const { device_id, psk } = request.query as { device_id?: string; psk?: string };
  if (!device_id || !psk || !(await authenticateAgent(device_id, psk))) {
    return reply.status(401).send({ error: "Geçersiz cihaz kimliği veya PSK" });
  }

  const result = await pool.query(
    `SELECT ti.metric_name, ti.connection_config
     FROM template_items ti
     JOIN device_templates dt ON dt.template_id = ti.template_id
     WHERE dt.device_id = $1 AND ti.collector_type = 'agent'`,
    [device_id]
  );
  return result.rows;
});

// Faz G: agent'in Docker/PostgreSQL/Redis plugin'lerinin baglanti bilgisini (endpoint/
// uri/adres) merkezi olarak sunar -- item senkronizasyonuyla (agent/items) AYNI PSK
// deseninde. Agent, kendi RefreshItemsSeconds dongusunde bunu da periyodik cekip
// initPlugins()'i gerekirse yeniden calistiracak (bkz. main.go degisikligi).
app.get("/api/v1/agent/plugin-config", async (request, reply) => {
  const { device_id, psk } = request.query as { device_id?: string; psk?: string };
  if (!device_id || !psk || !(await authenticateAgent(device_id, psk))) {
    return reply.status(401).send({ error: "Geçersiz cihaz kimliği veya PSK" });
  }
  const result = await pool.query(`SELECT agent_plugin_config FROM devices WHERE id = $1`, [device_id]);
  const encrypted = result.rows[0]?.agent_plugin_config;
  if (!encrypted) return {};
  try {
    return JSON.parse(decryptSecret(encrypted));
  } catch {
    return {};
  }
});

// Dashboard'un "Agent" sekmesinde plugin config'i GÖSTERMESİ için -- postgres.uri
// parola icerdigi icin maskelenir (makrolardaki secret degerler gibi, duz metin/sifreli
// hali arayuzde hicbir zaman gorunmez).
app.get("/api/v1/devices/:id/agent-plugin-config", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("devices", id, auth.tenantId))) return reply.status(404).send({ error: "Cihaz bulunamadı" });
  const result = await pool.query(`SELECT agent_plugin_config FROM devices WHERE id = $1`, [id]);
  const encrypted = result.rows[0]?.agent_plugin_config;
  if (!encrypted) return {};
  let config: Record<string, any> = {};
  try {
    config = JSON.parse(decryptSecret(encrypted));
  } catch {
    return {};
  }
  if (config.postgres?.uri) {
    config.postgres = { ...config.postgres, uri: "••••••••" };
  }
  return config;
});

const UpdateAgentPluginConfigSchema = z.object({
  docker: z.object({ endpoint: z.string().optional() }).optional(),
  postgres: z.object({ uri: z.string().optional() }).optional(),
  redis: z.object({ address: z.string().optional() }).optional()
});

// Dashboard'un plugin config'i GÜNCELLEMESİ için -- kismi guncelleme (her plugin'in
// mevcut ayarinin uzerine sadece GELEN alanlari yazar). "••••••••" maskeli placeholder
// gelirse (kullanici o alani hic degistirmediyse), gercek eski degeri korur -- maskeyi
// gercek deger yerine kaydetmez.
app.patch("/api/v1/devices/:id/agent-plugin-config", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  if (!auth.canEditDevices) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  if (!(await idBelongsToTenant("devices", id, auth.tenantId))) return reply.status(404).send({ error: "Cihaz bulunamadı" });

  const parsed = UpdateAgentPluginConfigSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const existingResult = await pool.query(`SELECT agent_plugin_config FROM devices WHERE id = $1`, [id]);
  let current: Record<string, any> = {};
  if (existingResult.rows[0]?.agent_plugin_config) {
    try {
      current = JSON.parse(decryptSecret(existingResult.rows[0].agent_plugin_config));
    } catch {
      current = {};
    }
  }

  for (const plugin of ["docker", "postgres", "redis"] as const) {
    const incomingPlugin = parsed.data[plugin];
    if (!incomingPlugin) continue;
    const merged: Record<string, any> = { ...(current[plugin] || {}) };
    for (const [key, value] of Object.entries(incomingPlugin)) {
      if (value === "••••••••") continue;
      merged[key] = value;
    }
    current[plugin] = merged;
  }

  const encrypted = encryptSecret(JSON.stringify(current));
  await pool.query(`UPDATE devices SET agent_plugin_config = $1 WHERE id = $2`, [encrypted, id]);
  return { success: true };
});

// Hafif, sık (varsayılan 10sn) canlılık sinyali.
app.post("/api/v1/agent/heartbeat", async (request, reply) => {
  const { device_id, psk } = request.body as { device_id?: string; psk?: string };
  if (!device_id || !psk || !(await authenticateAgent(device_id, psk))) {
    return reply.status(401).send({ error: "Geçersiz cihaz kimliği veya PSK" });
  }

  await pool.query(`UPDATE devices SET last_heartbeat_at = now() WHERE id = $1`, [device_id]);

  const device = await pool.query(`SELECT tenant_id, status FROM devices WHERE id = $1`, [device_id]);
  await pool.query(
    `INSERT INTO device_collector_status (device_id, collector_type, status, last_checked_at)
     VALUES ($1, 'agent', 'active', now())
     ON CONFLICT (device_id, collector_type) DO UPDATE SET status = 'active', last_checked_at = now()`,
    [device_id]
  );
  const allStatuses = await pool.query(`SELECT status FROM device_collector_status WHERE device_id = $1`, [device_id]);
  const hasActive = allStatuses.rows.some((r) => r.status === "active");
  await pool.query(`UPDATE devices SET status = $1 WHERE id = $2`, [hasActive ? "active" : "down", device_id]);

  return reply.status(204).send();
});

// Tam metrik seti — agent tarafından gzip'siz JSON olarak gönderilir (Fastify zaten
// Content-Encoding: gzip header'ı varsa otomatik decode eder).
const AgentMetricsSchema = z.object({
  device_id: z.string().uuid(),
  psk: z.string(),
  agent_version: z.string().optional(),
  metrics: z.array(z.object({ metric_name: z.string(), value: z.number(), unit: z.string().optional(), interface: z.string().optional() }))
});

app.post("/api/v1/agent/metrics", async (request, reply) => {
  const parsed = AgentMetricsSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const { device_id, psk, agent_version, metrics } = parsed.data;
  if (!(await authenticateAgent(device_id, psk))) return reply.status(401).send({ error: "Geçersiz cihaz kimliği veya PSK" });

  const device = await pool.query(`SELECT tenant_id FROM devices WHERE id = $1`, [device_id]);
  if (device.rows.length === 0) return reply.status(404).send({ error: "Cihaz bulunamadı" });
  const tenantId = device.rows[0].tenant_id;

  const timestamp = new Date().toISOString();
  for (const metric of metrics) {
    await publishAgentMetric({
      event_type: "metric", source_module: "agent", tenant_id: tenantId, device_id,
      metric_name: metric.metric_name, timestamp, value: metric.value,
      unit: metric.unit, interface: metric.interface
    });
  }

  await pool.query(`UPDATE devices SET last_agent_checkin = now(), agent_version = $1 WHERE id = $2`, [agent_version || null, device_id]);

  return reply.status(204).send();
});


// ============ FAZ E AŞAMA 5 — AGENT KENDİ KENDİNİ GÜNCELLEME ============

// Agent, periyodik olarak (örn. günde bir kez) kendi platformu için en güncel sürümü
// sorar. Sürümü kendisinden farklıysa, checksum'ı kaydedip yeni binary'i indirir.
app.get("/api/v1/agent/latest-release", async (request) => {
  const { platform } = request.query as { platform?: string };
  if (!platform) return { version: null };

  const result = await pool.query(
    `SELECT version, sha256_checksum FROM agent_releases WHERE platform = $1 ORDER BY released_at DESC LIMIT 1`,
    [platform]
  );
  if (result.rows.length === 0) return { version: null };
  return { version: result.rows[0].version, sha256_checksum: result.rows[0].sha256_checksum };
});

// Belirli bir sürüm+platform için binary'nin kendisini (ham byte olarak) döner.
app.get("/api/v1/agent/download/:platform/:version", async (request, reply) => {
  const { platform, version } = request.params as { platform: string; version: string };
  const result = await pool.query(
    `SELECT file_path FROM agent_releases WHERE platform = $1 AND version = $2`,
    [platform, version]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Bu sürüm/platform için binary bulunamadı" });

  const fs = await import("fs");
  const stream = fs.createReadStream(result.rows[0].file_path);
  reply.header("Content-Type", "application/octet-stream");
  return reply.send(stream);
});

// Admin — yeni bir sürüm yayınlama (checksum hesaplama backend'de yapılır, dosya
// yolu sunucudaki bir dizine önceden yüklenmiş olmalı — basit bir MVP akışı).
// Agent Sürümleri yönetim sayfasının listesi için (dashboard'ın kendisi bu ana kadar
// SADECE latest-release/download endpoint'lerini kullanabiliyordu, TÜM sürümleri
// gösterecek bir liste yoktu).
app.get("/api/v1/agent-releases", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditDevices) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const result = await pool.query(
    `SELECT id, version, platform, sha256_checksum, released_at FROM agent_releases ORDER BY released_at DESC`
  );
  return result.rows;
});

const PublishReleaseSchema = z.object({
  version: z.string(),
  platform: z.string(),
  file_path: z.string()
});

app.post("/api/v1/agent-releases", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.canEditDevices) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const parsed = PublishReleaseSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const fs = await import("fs");
  if (!fs.existsSync(parsed.data.file_path)) return reply.status(400).send({ error: "Belirtilen dosya yolu sunucuda bulunamadı" });

  const fileBuffer = fs.readFileSync(parsed.data.file_path);
  const checksum = crypto.createHash("sha256").update(fileBuffer).digest("hex");

  const result = await pool.query(
    `INSERT INTO agent_releases (version, platform, file_path, sha256_checksum) VALUES ($1, $2, $3, $4)
     ON CONFLICT (platform, version) DO UPDATE SET file_path = $3, sha256_checksum = $4
     RETURNING id, version, platform, sha256_checksum`,
    [parsed.data.version, parsed.data.platform, parsed.data.file_path, checksum]
  );
  return reply.status(201).send(result.rows[0]);
});


// Device Detail'in "Agent" sekmesi için — cihazın agent ile ilgili durumunu döner.
app.get("/api/v1/devices/:id/agent-status", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("devices", id, auth.tenantId))) return reply.status(404).send({ error: "Cihaz bulunamadı" });

  const result = await pool.query(
    `SELECT last_agent_checkin, last_heartbeat_at, agent_version,
            (agent_psk IS NOT NULL) as is_agent_registered
     FROM devices WHERE id = $1`,
    [id]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Cihaz bulunamadı" });
  return result.rows[0];
});


// ============ ITEM SCHEDULE STATE (Queue altyapısının temeli) ============

// Bu collector_type'a ait, henüz item_schedule_state'te hiç kaydı olmayan
// (template_item, device) çiftleri için yeni satır oluşturur (idempotent).
// Her collector, kendi "tick" döngüsünde asıl toplamadan ÖNCE bunu çağırır --
// yeni item/template ataması otomatik yakalanır, elle bir şey yapmaya gerek yok.
app.post("/api/v1/internal/schedule/reconcile", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const { collector_type } = request.body as { collector_type: string };
  if (!collector_type) return reply.status(400).send({ error: "collector_type gerekli" });

  if (collector_type === "web_scenario") {
    // GERCEK BUG DUZELTMESI: onceki halinde LEFT JOIN + COALESCE(dt.device_id, ws.id)
    // vardi -- bir web_scenario HICBIR cihaza atanmamissa (template hicbir device'a
    // atanmamis), device_id olarak SENARYONUN KENDI ID'sini kullaniyordu. device_id
    // sutunu devices(id)'e foreign key oldugu icin bu INSERT foreign key ihlali ile
    // BASARISIZ olurdu (ws.id, devices tablosunda yok). INNER JOIN'e cevirip, SADECE
    // gercekten bir cihaza atanmis senaryolar icin satir olusturuyoruz.
    await pool.query(
      `INSERT INTO item_schedule_state (device_id, resource_type, resource_id, collector_type, polling_interval_seconds, next_due_at)
       SELECT DISTINCT dt.device_id, 'web_scenario', ws.id, 'web_scenario', ws.polling_interval_seconds, now()
       FROM web_scenarios ws
       JOIN alert_templates t ON t.id = ws.template_id
       JOIN device_templates dt ON dt.template_id = t.id
       ON CONFLICT (device_id, resource_type, resource_id) DO NOTHING`
    );
    // GERCEK EKSIKLIK DUZELTMESI: reconcile onceden SADECE ekleme yapiyordu -- bir
    // senaryonun cihaz ataması kaldırılırsa (device_templates'ten silinirse), ya da
    // senaryonun kendisi silinirse, item_schedule_state'teki karsilik gelen satir HIC
    // temizlenmiyordu. Böyle bir "hayalet" kayit, hicbir zaman toplanamayacagi icin
    // sonsuza dek Queue'da "gecikmis" gibi gorunurdu. Artik gecersiz olanlari temizliyoruz.
    await pool.query(
      `DELETE FROM item_schedule_state s
       WHERE s.resource_type = 'web_scenario'
         AND NOT EXISTS (
           SELECT 1 FROM web_scenarios ws
           JOIN alert_templates t ON t.id = ws.template_id
           JOIN device_templates dt ON dt.template_id = t.id
           WHERE ws.id = s.resource_id AND dt.device_id = s.device_id
         )`
    );
  } else {
    // GERCEK BUG DUZELTMESI: master_item_id dolu olan (dependent) item'lar kendi ag
    // cagrisini yapmaz, master'in yanitindan turetilir -- bu yuzden HICBIR ZAMAN
    // mark-collected cagrisi ALAMAZLAR (collector'larin "collectedIds" listesi sadece
    // master+independent item ID'lerini icerir). Bu filtre olmadan, dependent item'lar
    // item_schedule_state'e ekleniyor ama SONSUZA DEK "gecikmis" gorunuyorlardi.
    await pool.query(
      `INSERT INTO item_schedule_state (device_id, resource_type, resource_id, collector_type, polling_interval_seconds, next_due_at)
       SELECT dt.device_id, 'template_item', ti.id, ti.collector_type, ti.polling_interval_seconds, now()
       FROM template_items ti
       JOIN device_templates dt ON dt.template_id = ti.template_id
       WHERE ti.collector_type = $1 AND ti.master_item_id IS NULL
       ON CONFLICT (device_id, resource_type, resource_id) DO NOTHING`,
      [collector_type]
    );
    // Ayni gerekce: bu collector_type'a ait, artik gecersiz olan (template atamasi
    // kaldirilmis / item silinmis / SONRADAN bir master'a bagli hale getirilmis)
    // satirlari temizle.
    await pool.query(
      `DELETE FROM item_schedule_state s
       WHERE s.resource_type = 'template_item' AND s.collector_type = $1
         AND NOT EXISTS (
           SELECT 1 FROM template_items ti
           JOIN device_templates dt ON dt.template_id = ti.template_id
           WHERE ti.id = s.resource_id AND dt.device_id = s.device_id
             AND ti.collector_type = $1 AND ti.master_item_id IS NULL
         )`,
      [collector_type]
    );
  }
  return reply.status(204).send();
});

// Vadesi gelmiş (next_due_at <= now()) kayıtları, en eskiden başlayarak, verilen
// limitle döner -- Zabbix'in poller worker havuzu mantığının karşılığı (sınırsız
// eşzamanlılıkta "queue" kavramı anlamsızlaşır).
app.get("/api/v1/internal/schedule/due", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const { collector_type, limit } = request.query as { collector_type?: string; limit?: string };
  if (!collector_type) return reply.status(400).send({ error: "collector_type gerekli" });

  const result = await pool.query(
    `SELECT device_id, resource_type, resource_id FROM item_schedule_state
     WHERE collector_type = $1 AND next_due_at <= now()
     ORDER BY next_due_at ASC LIMIT $2`,
    [collector_type, Math.min(Number(limit) || 100, 500)]
  );
  return result.rows;
});

// Bir item'ın toplaması tamamlandıktan sonra çağrılır -- next_due_at'i
// polling_interval_seconds kadar ileri alır, teşhis bilgilerini (süre, hata) kaydeder.
app.post("/api/v1/internal/schedule/mark-collected", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const { device_id, resource_type, resource_id, duration_ms, error } = request.body as {
    device_id: string; resource_type: string; resource_id: string; duration_ms?: number; error?: string;
  };
  if (!device_id || !resource_type || !resource_id) return reply.status(400).send({ error: "device_id, resource_type, resource_id gerekli" });

  await pool.query(
    `UPDATE item_schedule_state
     SET next_due_at = now() + (polling_interval_seconds || ' seconds')::interval,
         last_collected_at = now(), last_duration_ms = $4, last_error = $5
     WHERE device_id = $1 AND resource_type = $2 AND resource_id = $3`,
    [device_id, resource_type, resource_id, duration_ms || null, error || null]
  );
  return reply.status(204).send();
});


// ============ QUEUE (Zabbix "Queue overview"in karşılığı) ============

// Her collector tipinin ne kadar geride kaldığını, gecikme kovalarına göre gösterir.
// Kovalar BOŞLUKSUZ tasarlandı (her gecikme mutlaka bir kovaya düşer) -- Zabbix'in
// ekranındaki "5dk" ile "10dk+" arasında görünürde bir boşluk vardı, biz bunu
// dürüstçe ">5 dakika" olarak birleştirdik, veri kaybı/yanlış izlenim olmasın.
app.get("/api/v1/queue/overview", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT
       s.collector_type,
       COUNT(*) FILTER (WHERE s.next_due_at > now())::int as not_due,
       COUNT(*) FILTER (WHERE now() - s.next_due_at > interval '0 seconds' AND now() - s.next_due_at <= interval '5 seconds')::int as bucket_5s,
       COUNT(*) FILTER (WHERE now() - s.next_due_at > interval '5 seconds' AND now() - s.next_due_at <= interval '10 seconds')::int as bucket_10s,
       COUNT(*) FILTER (WHERE now() - s.next_due_at > interval '10 seconds' AND now() - s.next_due_at <= interval '30 seconds')::int as bucket_30s,
       COUNT(*) FILTER (WHERE now() - s.next_due_at > interval '30 seconds' AND now() - s.next_due_at <= interval '1 minute')::int as bucket_1m,
       COUNT(*) FILTER (WHERE now() - s.next_due_at > interval '1 minute' AND now() - s.next_due_at <= interval '5 minutes')::int as bucket_5m,
       COUNT(*) FILTER (WHERE now() - s.next_due_at > interval '5 minutes')::int as bucket_over_5m,
       COUNT(*)::int as total
     FROM item_schedule_state s
     JOIN devices d ON d.id = s.device_id
     WHERE d.tenant_id = $1
     GROUP BY s.collector_type
     ORDER BY s.collector_type`,
    [auth.tenantId]
  );

  // Agent (push modeli) -- item_schedule_state'e hiç dahil değil, ayrı bir satır
  // olarak, devices.last_heartbeat_at'e göre hesaplanan gecikmeyle ekleniyor.
  // Beklenen aralık 10sn (agent'ın varsayılan heartbeat periyodu) kabul ediliyor.
  const agentResult = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE last_heartbeat_at IS NOT NULL AND now() - last_heartbeat_at <= interval '10 seconds')::int as not_due,
       COUNT(*) FILTER (WHERE last_heartbeat_at IS NOT NULL AND now() - last_heartbeat_at > interval '10 seconds' AND now() - last_heartbeat_at <= interval '15 seconds')::int as bucket_5s,
       COUNT(*) FILTER (WHERE last_heartbeat_at IS NOT NULL AND now() - last_heartbeat_at > interval '15 seconds' AND now() - last_heartbeat_at <= interval '20 seconds')::int as bucket_10s,
       COUNT(*) FILTER (WHERE last_heartbeat_at IS NOT NULL AND now() - last_heartbeat_at > interval '20 seconds' AND now() - last_heartbeat_at <= interval '40 seconds')::int as bucket_30s,
       COUNT(*) FILTER (WHERE last_heartbeat_at IS NOT NULL AND now() - last_heartbeat_at > interval '40 seconds' AND now() - last_heartbeat_at <= interval '1 minute 10 seconds')::int as bucket_1m,
       COUNT(*) FILTER (WHERE last_heartbeat_at IS NOT NULL AND now() - last_heartbeat_at > interval '1 minute 10 seconds' AND now() - last_heartbeat_at <= interval '5 minutes 10 seconds')::int as bucket_5m,
       COUNT(*) FILTER (WHERE last_heartbeat_at IS NOT NULL AND now() - last_heartbeat_at > interval '5 minutes 10 seconds')::int as bucket_over_5m,
       COUNT(*) FILTER (WHERE agent_psk IS NOT NULL)::int as total
     FROM devices WHERE tenant_id = $1 AND agent_psk IS NOT NULL`,
    [auth.tenantId]
  );

  const rows = [...result.rows];
  if (agentResult.rows[0].total > 0) {
    rows.push({ collector_type: "agent", ...agentResult.rows[0] });
  }
  return rows;
});

// Tek bir collector tipinin (ve/veya tek bir cihazın) gecikmiş item'larını satır
// satır listeler -- Zabbix'in "Queue details" görünümünün karşılığı.
app.get("/api/v1/queue/details", async (request) => {
  const auth = (request as any).auth;
  const { collector_type, device_id } = request.query as { collector_type?: string; device_id?: string };

  const conditions = ["d.tenant_id = $1", "s.next_due_at <= now()"];
  const params: any[] = [auth.tenantId];
  let paramIndex = 2;
  if (collector_type) {
    conditions.push(`s.collector_type = $${paramIndex}`);
    params.push(collector_type);
    paramIndex++;
  }
  if (device_id) {
    conditions.push(`s.device_id = $${paramIndex}`);
    params.push(device_id);
    paramIndex++;
  }

  const result = await pool.query(
    `SELECT s.device_id, d.name as device_name, s.resource_type, s.resource_id, s.collector_type,
            s.next_due_at, s.last_collected_at, s.last_duration_ms, s.last_error,
            EXTRACT(EPOCH FROM (now() - s.next_due_at))::int as delay_seconds,
            COALESCE(ti.metric_name, ws.name) as resource_name
     FROM item_schedule_state s
     JOIN devices d ON d.id = s.device_id
     LEFT JOIN template_items ti ON s.resource_type = 'template_item' AND ti.id = s.resource_id
     LEFT JOIN web_scenarios ws ON s.resource_type = 'web_scenario' AND ws.id = s.resource_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY s.next_due_at ASC LIMIT 200`,
    params
  );
  return result.rows;
});

const port = Number(process.env.PORT) || 3000;
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
