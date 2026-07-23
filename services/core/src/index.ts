import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import zlib from "zlib";
import crypto from "crypto";
import { z } from "zod";
import { encryptSecret, decryptSecret } from "./crypto.js";
import { authenticateViaLdap } from "./ldapAuth.js";
import ldap from "ldapjs";
import { generateRegistrationToken, hashRegistrationToken, generateDevicePsk, hashDevicePsk } from "./agentAuth.js";
import { publishAgentMetric } from "./redisClient.js";
import { generateApiToken, hashApiToken } from "./apiTokens.js";
import bcrypt from "bcryptjs";
import { pool, checkDbConnection, queryClickHouse } from "./db.js";
import { computeRootCauseCandidates } from "./rootCause.js";
import { signToken } from "./auth.js";

// ACİL DÜZELTME: trustProxy olmadan, gateway TÜM trafiği proxy'lediği için
// core-service'in gördüğü request.ip HER ZAMAN gateway'in TEK container IP'si
// oluyordu -- rate-limit'in varsayılan IP-bazlı anahtarlaması yüzünden, dashboard
// trafiği + agent heartbeat'leri + admin API testleri hepsi AYNI 300/dakikalık
// kovayı paylaşıyordu. Sonuç: yoğun kullanım (örn. kapsamlı API testi) gerçek
// agent heartbeat'lerinin de 429 almasına yol açtı -- canlıda gözlemlendi.
// trustProxy:true ile Fastify artık gateway'in X-Forwarded-For header'ına güvenip
// request.ip'yi GERÇEK çağıranın IP'sine çözüyor, her kaynak kendi kovasını alıyor.
const app = Fastify({ logger: true, trustProxy: true });

// GÜVENLİK DÜZELTMESİ: hiçbir rate limiting yoktu -- en kritik etkisi /api/v1/auth/login
// üzerinde şifre brute-force riskiydi (agent PSK/registration token'ları zaten 256-bit
// entropiye sahip olduğu için o taraftaki risk düşüktü). Global varsayılan gevşek tutuldu
// (normal API kullanımını etkilemesin diye), login endpoint'i kendi route config'inde
// (aşağıda) çok daha sıkı bir limitle ezilir.
//
// ÖNEMLİ: "await" burada ZORUNLU -- olmadan (ESM ortamında, aynı senkron blokta hemen
// ardından çok sayıda route tanımlanınca) plugin'in global onRequest hook'u sessizce
// devreye girmiyor, hiçbir istek asla 429 almıyor, hiçbir hata/uyarı da vermiyor. Bu,
// izole testlerle (bkz. sunucudaki minimal_test2.mjs / minimal_test3.mjs) doğrulandı.
// GERÇEK EKSİKLİK DÜZELTMESİ (canlı ortamda gözlemlendi): 300/dk, zengin
// çoklu-widget dashboard'un (aynı anda alerts+metrics+latest-data+cihaz
// bilgisi gibi birden fazla sorgu + birden fazla sekme/pencere) GERÇEK, art
// arda tekrar denemesi (retry storm'u önceden ayrı düzeltildi) OLMAYAN
// normal kullanımıyla bile aşılıyordu -- core logları tek bir dakikada 401
// gerçek istek gösterdi, limitin hemen altında. 1000/dk'ya çıkarıldı --
// hâlâ patolojik bir döngüye (örn. gelecekte bir başka retry-storm türü)
// karşı anlamlı bir üst sınır, ama gerçek kullanımı boğmuyor.
await app.register(rateLimit, {
  global: true,
  max: 1000,
  timeWindow: "1 minute",
  // GÜVENLİK/İSTİKRAR: agent (PSK ile) ve internal-servis (x-internal-secret ile)
  // rotaları zaten KENDİ kimlik doğrulama mekanizmalarına sahip -- genel IP-bazlı
  // rate limit'e tabi tutulmaları gereksiz risk taşıyor (bkz. yukarıdaki trustProxy
  // notu: paylaşımlı bir kovada gerçek cihaz trafiğinin sessizce 429 alması).
  allowList: (request) => {
    const url = request.url || "";
    return url.startsWith("/api/v1/agent/") || url.startsWith("/api/v1/internal/");
  }
});

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

// FAZ 4: bir kullanıcının üye olduğu grupların frontend_access ayarlarından giriş
// yöntemini çözer. Öncelik sırası: 'disabled' > 'ldap' > 'internal'/'system_default'
// -- yani bir kullanıcı hem 'ldap' hem 'internal' gruba üyeyse LDAP tercih edilir
// (daha kısıtlayıcı/merkezi olan kazanır); herhangi bir grubu 'disabled' ise
// (diğerleri ne derse desin) giriş tamamen engellenir.
async function resolveAuthMethodForUser(userId: string): Promise<"disabled" | "ldap" | "internal"> {
  const result = await pool.query(
    `SELECT DISTINCT ug.frontend_access FROM user_group_members ugm
     JOIN user_groups ug ON ug.id = ugm.user_group_id
     WHERE ugm.user_id = $1 AND ug.enabled = true`,
    [userId]
  );
  const values = result.rows.map((r) => r.frontend_access);
  if (values.includes("disabled")) return "disabled";
  if (values.includes("ldap")) return "ldap";
  return "internal";
}

async function idBelongsToTenant(table: string, id: string, tenantId: string): Promise<boolean> {
  return idsBelongToTenant(table, [id], tenantId);
}

// Şablon kütüphanesi v2: korumalı (is_protected) bir şablonun item/kural
// listesini doğrudan değiştirmeye izin verilmez -- önce klonlanması gerekir
// (bkz. POST /alert-templates/:id/clone). templateId doğrudan verilmemişse
// (item/kural id'sinden geliyorsa) resolveQuery ile önce template_id'ye
// ulaşılır.
async function templateIsProtected(templateId: string): Promise<boolean> {
  const result = await pool.query(`SELECT is_protected FROM alert_templates WHERE id = $1`, [templateId]);
  return result.rows[0]?.is_protected === true;
}

async function templateItemIsProtected(templateItemId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT t.is_protected FROM template_items ti JOIN alert_templates t ON t.id = ti.template_id WHERE ti.id = $1`,
    [templateItemId]
  );
  return result.rows[0]?.is_protected === true;
}

async function templateRuleIsProtected(templateRuleId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT t.is_protected FROM alert_template_rules r JOIN alert_templates t ON t.id = r.template_id WHERE r.id = $1`,
    [templateRuleId]
  );
  return result.rows[0]?.is_protected === true;
}

const PROTECTED_TEMPLATE_ERROR = { error: "Bu temel (korumalı) bir şablon -- değiştirmek için önce kopyalayın (Kopyala butonu)" };

// Value map genişletmesi: if_oper_status dışında da onlarca 0/1 durum metriği
// var (tcp_port/DNS/Kafka/Mongo/RabbitMQ/TLS "_reachable", web senaryolarının
// "_status" ve "_any_step_failed" metrikleri) -- bunlar kullanıcının kendi
// verdiği (dinamik, önceden bilinemeyen) isimlerle üretiliyor, exact-match
// metric_value_maps tablosuna sığmıyor. Son-ek (suffix) bazlı bir kural ile
// çözülüyor -- "_any_step_failed" TERS anlamlı olduğu için (1=hata VAR)
// AYRI bir value map kullanır, diğerlerinin hepsi (1=başarılı/erişilebilir)
// aynı value map'i paylaşır.
async function getStatusSuffixValueMapIds(tenantId: string): Promise<{ reachable: string | null; stepFailed: string | null }> {
  const result = await pool.query(
    `SELECT name, id FROM value_maps WHERE tenant_id = $1 AND name IN ('Erişilebilirlik Durumu', 'Adım Hatası Durumu')`,
    [tenantId]
  );
  const byName = new Map(result.rows.map((r) => [r.name, r.id]));
  return { reachable: byName.get("Erişilebilirlik Durumu") ?? null, stepFailed: byName.get("Adım Hatası Durumu") ?? null };
}

function resolveStatusSuffixValueMapId(metricName: string, ids: { reachable: string | null; stepFailed: string | null }): string | null {
  if (metricName.endsWith("_any_step_failed")) return ids.stepFailed;
  if (metricName.endsWith("_reachable") || metricName.endsWith("_status")) return ids.reachable;
  return null;
}

// FAZ 1: rolün user_role_permissions'taki kaynak->seviye satırlarını bir haritaya
// (resource -> 'none'|'read'|'read_write') çevirir. roleId null ise (kullanıcıya
// hiç rol atanmamış) veya rolün hiç izin satırı yoksa, BOŞ harita döner -- yani
// varsayılan DENY (Zabbix'te de bir role hiçbir izin verilmemişse hiçbir şey
// göremez/yapamaz, "her şeye izinli" değil).
async function resolvePermissionsForRole(roleId: string | null): Promise<Record<string, string>> {
  if (!roleId) return {};
  const result = await pool.query(
    `SELECT resource, level FROM user_role_permissions WHERE role_id = $1`,
    [roleId]
  );
  const permissions: Record<string, string> = {};
  for (const row of result.rows) permissions[row.resource] = row.level;
  return permissions;
}

// FAZ 1: bir kullanıcının ÜYE OLDUĞU TÜM user_group'ların belirli bir device_group
// için verdiği izinleri Zabbix kuralıyla birleştirir: aynı device_group üzerinde
// HERHANGİ BİR grup 'deny' diyorsa sonuç deny'dir (başka bir grup read_write dese
// bile); deny yoksa read_write > read (en gevşek olan kazanır).
async function resolveDeviceGroupAccess(userId: string): Promise<Record<string, "read" | "read_write" | "deny">> {
  const result = await pool.query(
    `SELECT ugdp.device_group_id, ugdp.permission
     FROM user_group_device_permissions ugdp
     JOIN user_group_members ugm ON ugm.user_group_id = ugdp.user_group_id
     WHERE ugm.user_id = $1`,
    [userId]
  );
  const access: Record<string, "read" | "read_write" | "deny"> = {};
  for (const row of result.rows) {
    const existing = access[row.device_group_id];
    if (existing === "deny" || row.permission === "deny") {
      access[row.device_group_id] = "deny";
    } else if (existing === "read_write" || row.permission === "read_write") {
      access[row.device_group_id] = "read_write";
    } else {
      access[row.device_group_id] = "read";
    }
  }
  return access;
}

// FAZ 3 (bkz. DENETIM_RAPORU.md / mimari tartışma): kullanıcının üye olduğu
// gruplardan, erişimi olduğu (deny olmayan) her device_group için tag filtresi
// çözümlemesi. Zabbix'in kuralı: bir cihaz birden fazla device_group'a üye
// olabilir; kullanıcının bu cihaza erişimini sağlayan gruplardan HERHANGİ BİRİ
// o device_group için hiç tag filtresi tanımlamamışsa (yani "kısıtlamasız"),
// cihazın tüm alarmları görünür -- SADECE erişimi sağlayan grupların TÜMÜ o
// device_group için tag filtresi tanımlamışsa, alarmın bu filtrelerden en az
// birine uyması gerekir (birden fazla grup varsa filtreler birleşir/OR'lanır).
// Dönüş: device_group_id -> null (kısıtlamasız) | {tag,value}[] (bu listeden
// en az biriyle eşleşmeli).
async function resolveTagRestrictions(userId: string): Promise<Map<string, { tag: string; value: string | null }[] | null>> {
  const accessRows = await pool.query(
    `SELECT ugdp.user_group_id, ugdp.device_group_id
     FROM user_group_device_permissions ugdp
     JOIN user_group_members ugm ON ugm.user_group_id = ugdp.user_group_id
     WHERE ugm.user_id = $1 AND ugdp.permission != 'deny'`,
    [userId]
  );
  const result = new Map<string, { tag: string; value: string | null }[] | null>();
  if (accessRows.rows.length === 0) return result;

  const filterRows = await pool.query(
    `SELECT ugtf.user_group_id, ugtf.device_group_id, ugtf.tag, ugtf.value
     FROM user_group_tag_filters ugtf
     JOIN user_group_members ugm ON ugm.user_group_id = ugtf.user_group_id
     WHERE ugm.user_id = $1`,
    [userId]
  );
  const filtersByGroupDg = new Map<string, { tag: string; value: string | null }[]>();
  for (const row of filterRows.rows) {
    const key = `${row.user_group_id}:${row.device_group_id}`;
    if (!filtersByGroupDg.has(key)) filtersByGroupDg.set(key, []);
    filtersByGroupDg.get(key)!.push({ tag: row.tag, value: row.value });
  }

  const dgToGroups = new Map<string, Set<string>>();
  for (const row of accessRows.rows) {
    if (!dgToGroups.has(row.device_group_id)) dgToGroups.set(row.device_group_id, new Set());
    dgToGroups.get(row.device_group_id)!.add(row.user_group_id);
  }

  for (const [dgId, groupIds] of dgToGroups) {
    let unrestricted = false;
    const allFilters: { tag: string; value: string | null }[] = [];
    for (const groupId of groupIds) {
      const filters = filtersByGroupDg.get(`${groupId}:${dgId}`);
      if (!filters || filters.length === 0) {
        unrestricted = true;
        break;
      }
      allFilters.push(...filters);
    }
    result.set(dgId, unrestricted ? null : allFilters);
  }
  return result;
}

// Bir alarmın (tags dizisi + üyesi olduğu device_group id listesi) tag
// kısıtlamalarını geçip geçmediğini kontrol eder. Kullanıcının erişimiyle
// ilgisi olmayan device_group'lar (tagRestrictions'ta hiç yoksa) yok sayılır.
function alertPassesTagRestrictions(
  alertTags: { tag: string; value?: string }[] | null,
  deviceGroupIds: string[],
  tagRestrictions: Map<string, { tag: string; value: string | null }[] | null>
): boolean {
  const relevantDgIds = deviceGroupIds.filter((id) => tagRestrictions.has(id));
  if (relevantDgIds.length === 0) return true; // kullanıcının bu cihaza erişimi tag-kısıtlı bir gruptan gelmiyor
  const hasUnrestrictedGroup = relevantDgIds.some((id) => tagRestrictions.get(id) === null);
  if (hasUnrestrictedGroup) return true;

  const allFilters = relevantDgIds.flatMap((id) => tagRestrictions.get(id) || []);
  const tags = alertTags || [];
  return allFilters.some((f) =>
    tags.some((t) => t.tag === f.tag && (f.value === null || f.value === "" || t.value === f.value))
  );
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

// FAZ 1: platformdaki tüm izinlendirilebilir kaynaklar (dashboard menü bölümleriyle
// birebir eşleşir). Yeni bir sayfa/modül eklendiğinde buraya da eklenmeli.
const ALL_RESOURCES = [
  "devices", "device_groups", "templates", "alert_rules", "maintenance",
  "webscenarios", "queue", "users", "user_roles", "user_groups",
  "agent_releases", "audit_log", "dashboards", "macros", "value_maps",
  "topology", "relations", "notifications"
];
// Yeni bir tenant kaydolduğunda "Viewer" rolüne varsayılan olarak GÖRÜNMEYECEK
// (idari/yönetimsel) kaynaklar -- geri kalan her şey 'read' alır.
const ADMIN_ONLY_RESOURCES = new Set(["users", "user_roles", "user_groups", "agent_releases", "audit_log"]);

app.post("/api/v1/auth/register", {
  config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
}, async (request, reply) => {
  const parsed = RegisterSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { tenantName, email, password } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenantResult = await client.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [tenantName]);
    const tenantId = tenantResult.rows[0].id;

    // Varsayılan roller: Admin (tüm kaynaklarda tam yetki) ve Viewer (idari
    // olmayan kaynaklarda salt-okunur). Eski 3 sabit boolean yerine, her kaynak
    // için ayrı bir user_role_permissions satırı ekleniyor.
    const adminRoleResult = await client.query(
      `INSERT INTO user_roles (tenant_id, name) VALUES ($1, 'Admin') RETURNING id`,
      [tenantId]
    );
    const adminRoleId = adminRoleResult.rows[0].id;
    for (const resource of ALL_RESOURCES) {
      await client.query(
        `INSERT INTO user_role_permissions (role_id, resource, level) VALUES ($1, $2, 'read_write')`,
        [adminRoleId, resource]
      );
    }

    const viewerRoleResult = await client.query(
      `INSERT INTO user_roles (tenant_id, name) VALUES ($1, 'Viewer') RETURNING id`,
      [tenantId]
    );
    const viewerRoleId = viewerRoleResult.rows[0].id;
    for (const resource of ALL_RESOURCES) {
      const level = ADMIN_ONLY_RESOURCES.has(resource) ? "none" : "read";
      await client.query(
        `INSERT INTO user_role_permissions (role_id, resource, level) VALUES ($1, $2, $3)`,
        [viewerRoleId, resource, level]
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, role_id) VALUES ($1, $2, $3, $4) RETURNING id, email`,
      [tenantId, email, passwordHash, adminRoleId]
    );
    await client.query("COMMIT");
    const user = userResult.rows[0];
    const permissions = await resolvePermissionsForRole(adminRoleId);
    const token = signToken({
      userId: user.id, tenantId, email: user.email, roleId: adminRoleId, permissions
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

app.post("/api/v1/auth/login", {
  // GÜVENLİK DÜZELTMESİ: şifre brute-force'a karşı IP başına sıkı limit.
  config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
}, async (request, reply) => {
  const parsed = LoginSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { email, password } = parsed.data;

  const result = await pool.query(
    `SELECT id, tenant_id, email, password_hash, role_id, enabled FROM users WHERE email = $1`,
    [email]
  );
  if (result.rows.length === 0) return reply.status(401).send({ error: "Geçersiz email veya şifre" });

  const user = result.rows[0];

  // Kullanıcı bazında devre dışı bırakma (grup bazında frontend_access='disabled'
  // ile karışmasın -- bu, TEK bir kullanıcıyı hedefler).
  if (user.enabled === false) {
    return reply.status(403).send({ error: "Bu kullanıcı devre dışı bırakılmış" });
  }

  // FAZ 4: kullanıcının üye olduğu gruplara göre giriş yöntemini belirle.
  const authMethod = await resolveAuthMethodForUser(user.id);
  if (authMethod === "disabled") {
    return reply.status(403).send({ error: "Bu kullanıcı için giriş devre dışı bırakılmış" });
  }
  if (authMethod === "ldap") {
    const ldapConfigResult = await pool.query(
      `SELECT host, port, bind_dn, bind_password_encrypted, base_dn, user_search_filter, use_tls
       FROM ldap_configs WHERE tenant_id = $1 AND enabled = true`,
      [user.tenant_id]
    );
    if (ldapConfigResult.rows.length === 0) {
      // Yapılandırma eksik/devre dışı -- şifreyi yanlışlıkla yerel bcrypt'e
      // düşürüp DOĞRULAMAMAK önemli (LDAP'a atanmış bir kullanıcının yerel
      // password_hash'i genelde anlamsız/rastgele bir değerdir).
      return reply.status(500).send({ error: "LDAP yapılandırılmamış veya devre dışı, yönetici ile iletişime geçin" });
    }
    const ldapOk = await authenticateViaLdap(ldapConfigResult.rows[0], user.email, password);
    if (!ldapOk) return reply.status(401).send({ error: "Geçersiz email veya şifre" });
  } else {
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return reply.status(401).send({ error: "Geçersiz email veya şifre" });
  }

  // FAZ 1: eski "users.role = 'admin' ise her şeye izin ver" fallback'i KALDIRILDI --
  // artık tek yetki kaynağı user_role_permissions. Kullanıcının hiç rolü yoksa (veya
  // rolünün hiç izin satırı yoksa) varsayılan DENY: boş bir permissions haritasıyla
  // giriş yapar, hiçbir kaynağa erişemez -- bir admin ona rol atamalı.
  const permissions = await resolvePermissionsForRole(user.role_id);

  const token = signToken({
    userId: user.id, tenantId: user.tenant_id, email: user.email, roleId: user.role_id, permissions
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
  // GÜVENLİK DÜZELTMESİ: önceden ham secret "===" ile karşılaştırılıyordu (timing-attack
  // yüzeyi) -- agentAuth.ts'teki PSK/token karşılaştırmalarıyla tutarlı olacak şekilde
  // artık crypto.timingSafeEqual kullanılıyor. Uzunluklar farklıysa (bu zaten eşleşme
  // olamayacağı anlamına gelir) timingSafeEqual'ın fırlattığı hatayı yakalayıp false'a
  // düşüyoruz -- uzunluk farkının kendisi bir side-channel olmasın diye önce sabit
  // uzunluklu bir buffer'a hashleyip KIYASLIYORUZ (SHA-256), ham secret'ları değil.
  const internalSecret = request.headers["x-internal-secret"];
  const expectedSecret = process.env.INTERNAL_SERVICE_SECRET || "";
  if (internalSecret && expectedSecret) {
    const providedHash = crypto.createHash("sha256").update(String(internalSecret)).digest();
    const expectedHash = crypto.createHash("sha256").update(expectedSecret).digest();
    if (crypto.timingSafeEqual(providedHash, expectedHash)) {
      (request as any).auth = { isInternalService: true };
      return;
    }
  }

  const tenantId = request.headers["x-auth-tenant-id"];
  const userId = request.headers["x-auth-user-id"];
  const email = request.headers["x-auth-email"] as string;

  if (!tenantId || !userId) return reply.status(401).send({ error: "Kimlik doğrulama bilgisi eksik" });

  // GÜVENLİK DÜZELTMESİ (JWT donukluğu -- kullanıcı yönetimi denetiminde bulundu):
  // rol/izinler önceden SADECE login anında JWT'ye gömülüyordu ve token 8 saat
  // boyunca hiç yeniden doğrulanmıyordu -- bir admin kullanıcının rolünü/iznini
  // değiştirse, kullanıcıyı başka bir role atasa ya da devre dışı bıraksa bile,
  // zaten oturum açmış kullanıcı token süresi dolana kadar ESKİ yetkileriyle
  // çalışmaya devam ediyordu (API token yolu -- bkz. verify-api-token -- zaten
  // her istekte DB'den taze okuyordu, JWT yolu tutarsızdı). Artık roleId/enabled
  // JWT'den/gateway header'ından DEĞİL, her istekte users tablosundan taze
  // okunuyor -- JWT sadece kimliği (userId/tenantId) taşıyor, yetkiyi değil.
  const userRow = await pool.query(`SELECT enabled, role_id FROM users WHERE id = $1 AND tenant_id = $2`, [userId, tenantId]);
  if (userRow.rows.length === 0 || userRow.rows[0].enabled === false) {
    return reply.status(401).send({ error: "Kullanıcı bulunamadı veya devre dışı bırakılmış" });
  }
  const roleId: string | null = userRow.rows[0].role_id;
  const permissions = await resolvePermissionsForRole(roleId);

  (request as any).auth = { tenantId, userId, roleId, permissions, email, isInternalService: false };
});

// FAZ 1: her endpoint'in tek tek "auth.canEditDevices" gibi sabit boolean kontrol
// etmesi yerine, ortak bir yardımcı ile kaynak+seviye kontrolü yapılıyor.
// 'read' seviyesi istenirken kullanıcının 'read_write' izni olması da yeterlidir
// (daha geniş yetki, daha dar olanı kapsar) -- Zabbix'teki "Read-write ⊇ Read" kuralı.
function hasPermission(auth: any, resource: string, required: "read" | "read_write"): boolean {
  const level = auth?.permissions?.[resource];
  if (level === "read_write") return true;
  if (level === "read") return required === "read";
  return false;
}

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
  // Coğrafi Harita özelliği: host (cihaz) seviyesinde opsiyonel koordinat (Zabbix'teki
  // host inventory latitude/longitude alanlarıyla aynı mantık).
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  tags: z.array(z.string()).optional(),
  structured_tags: z.array(z.object({ tag: z.string(), value: z.string() })).optional(),
  attributes: z.record(z.any()).optional(),
  interfaces: z.array(z.object({
    interface_type: z.enum(["snmp", "ssh", "sql", "web", "vmware"]),
    ip_address: z.string().optional(),
    port: z.number().optional(),
    snmp_community: z.string().optional(),
    vmware_mode: z.enum(["vcenter", "esxi"]).optional(),
    tls_skip_verify: z.boolean().optional()
  })).optional()
});

const UpdateDeviceSchema = z.object({
  name: z.string().min(1).optional(),
  vendor: z.string().optional(),
  location: z.string().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
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

  // Granüler RBAC: kullanıcının üye olduğu grupların device-group izinlerine göre
  // (bkz. resolveDeviceGroupAccess -- çoklu grup üyeliği deny>read_write>read ile
  // birleştirilir). Hiç grup üyeliği/izin tanımı yoksa eski davranış korunur (kısıtlama
  // yok, tüm tenant cihazları görünür) -- bu tablo sadece kısıtlama eklemek istendiğinde
  // devreye girer.
  const deviceGroupAccess = await resolveDeviceGroupAccess(auth.userId);
  if (Object.keys(deviceGroupAccess).length > 0) {
    const allowedGroupIds = Object.entries(deviceGroupAccess)
      .filter(([, permission]) => permission !== "deny")
      .map(([groupId]) => groupId);
    if (allowedGroupIds.length === 0) {
      conditions.push("1 = 0");
    } else {
      conditions.push(`id IN (SELECT device_id FROM device_group_members WHERE device_group_id = ANY($${paramIndex}::uuid[]))`);
      params.push(allowedGroupIds);
      paramIndex++;
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
    `SELECT d.id, d.name, d.ip_address, d.device_type, d.vendor, d.location, d.latitude, d.longitude, d.status, d.attributes, d.created_at, d.enabled, d.tags,
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

// Coğrafi Harita: koordinatı olan cihazları + pin renklendirmesi için en kötü açık
// alarm severity'sini döndürür. Severity sıralaması alfabetik MAX(severity) ile
// YANLIŞ sonuç verir (örn. "warning" > "high" alfabetik olarak) -- bu yüzden
// notify.ts'teki SEVERITY_RANK ile aynı (critical > disaster > high > average >
// warning > info) CASE tabanlı sıralama kullanılıyor.
app.get("/api/v1/devices/map-locations", async (request) => {
  const auth = (request as any).auth;
  // Coğrafi Harita WIDGET'ı (Zabbix'in Geomap widget'ıyla aynı fikir): panoya
  // eklenen widget kendi Host grupları / Hosts / Tags filtresini taşıyabilir --
  // standalone /geo-map sayfası hiçbirini göndermez (tüm koordinatlı cihazları gösterir).
  const query = request.query as {
    device_group_ids?: string; // CSV uuid
    device_ids?: string; // CSV uuid
    tags?: string; // JSON: [{tag, value}]
    tag_logic?: "and" | "or";
  };

  const conditions: string[] = ["d.tenant_id = $1", "d.latitude IS NOT NULL", "d.longitude IS NOT NULL"];
  const params: any[] = [auth.tenantId];
  let paramIndex = 2;

  const deviceGroupAccess = await resolveDeviceGroupAccess(auth.userId);
  if (Object.keys(deviceGroupAccess).length > 0) {
    const allowedGroupIds = Object.entries(deviceGroupAccess)
      .filter(([, permission]) => permission !== "deny")
      .map(([groupId]) => groupId);
    if (allowedGroupIds.length === 0) {
      conditions.push("1 = 0");
    } else {
      conditions.push(`d.id IN (SELECT device_id FROM device_group_members WHERE device_group_id = ANY($${paramIndex}::uuid[]))`);
      params.push(allowedGroupIds);
      paramIndex++;
    }
  }

  // Widget'ın Host grupları + Hosts alanları Zabbix'teki gibi BİRLEŞİM (union) --
  // seçili gruplardan HERHANGİ birine ait olan VEYA doğrudan seçili host'lardan biri olan.
  const widgetGroupIds = query.device_group_ids?.split(",").map((s) => s.trim()).filter(Boolean) || [];
  const widgetDeviceIds = query.device_ids?.split(",").map((s) => s.trim()).filter(Boolean) || [];
  if (widgetGroupIds.length > 0 || widgetDeviceIds.length > 0) {
    const orParts: string[] = [];
    if (widgetGroupIds.length > 0) {
      orParts.push(`d.id IN (SELECT device_id FROM device_group_members WHERE device_group_id = ANY($${paramIndex}::uuid[]))`);
      params.push(widgetGroupIds);
      paramIndex++;
    }
    if (widgetDeviceIds.length > 0) {
      orParts.push(`d.id = ANY($${paramIndex}::uuid[])`);
      params.push(widgetDeviceIds);
      paramIndex++;
    }
    conditions.push(`(${orParts.join(" OR ")})`);
  }

  // Tags: devices.tags {tag,value} JSONB dizisi üzerinde EXISTS -- Zabbix'in
  // tag+value ("Contains") filtresiyle aynı fikir, satırlar And/Or ile birleşir.
  let parsedTags: { tag: string; value?: string }[] = [];
  try {
    if (query.tags) parsedTags = JSON.parse(query.tags);
  } catch {
    parsedTags = [];
  }
  if (Array.isArray(parsedTags) && parsedTags.length > 0) {
    const tagConditions = parsedTags
      .filter((t) => t && t.tag)
      .map((t) => {
        const tagParam = paramIndex++;
        params.push(t.tag);
        if (t.value) {
          const valueParam = paramIndex++;
          params.push(`%${t.value}%`);
          return `EXISTS (SELECT 1 FROM jsonb_array_elements(d.tags) te WHERE te->>'tag' = $${tagParam} AND te->>'value' ILIKE $${valueParam})`;
        }
        return `EXISTS (SELECT 1 FROM jsonb_array_elements(d.tags) te WHERE te->>'tag' = $${tagParam})`;
      });
    if (tagConditions.length > 0) {
      const joiner = query.tag_logic === "or" ? " OR " : " AND ";
      conditions.push(`(${tagConditions.join(joiner)})`);
    }
  }

  const result = await pool.query(
    `SELECT d.id, d.name, d.location, d.latitude, d.longitude, d.status,
            (SELECT COUNT(*)::int FROM alerts a WHERE a.device_id = d.id AND a.resolved_at IS NULL) as open_alert_count,
            (SELECT a2.severity FROM alerts a2 WHERE a2.device_id = d.id AND a2.resolved_at IS NULL
             ORDER BY CASE a2.severity WHEN 'critical' THEN 5 WHEN 'disaster' THEN 4 WHEN 'high' THEN 3 WHEN 'average' THEN 2 WHEN 'warning' THEN 1 WHEN 'info' THEN 0 ELSE 0 END DESC
             LIMIT 1) as max_severity
     FROM devices d
     WHERE ${conditions.join(" AND ")}
     ORDER BY d.name`,
    params
  );

  return result.rows;
});

app.get("/api/v1/devices/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  const result = await pool.query(
    `SELECT id, name, ip_address, device_type, vendor, location, latitude, longitude, status, attributes, created_at
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
  const { name, device_type, vendor, location, latitude, longitude, tags, structured_tags, attributes, interfaces } = parsed.data;
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
      `INSERT INTO devices (tenant_id, name, ip_address, device_type, vendor, location, latitude, longitude, attributes, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, name, ip_address, device_type, created_at`,
      [auth.tenantId, name, finalIpAddress, device_type, vendor || null, location || null, latitude ?? null, longitude ?? null, finalAttributes, JSON.stringify(structured_tags || [])]
    );
    const deviceId = result.rows[0].id;

    for (const iface of interfaces || []) {
      if (!iface.ip_address) continue;
      await client.query(
        `INSERT INTO device_interfaces (device_id, interface_type, ip_address, port, snmp_community, vmware_mode, tls_skip_verify) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [deviceId, iface.interface_type, iface.ip_address, iface.port || null, iface.snmp_community || null, iface.vmware_mode || null, iface.tls_skip_verify ?? false]
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
  const { name, vendor, location, latitude, longitude, tags, structured_tags, attributes, enabled } = parsed.data;

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
       enabled = COALESCE($8, enabled),
       latitude = COALESCE($9, latitude),
       longitude = COALESCE($10, longitude)
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, name, ip_address, device_type, vendor, location, latitude, longitude, status, attributes, tags, enabled`,
    [auth.tenantId, id, name, vendor, location, mergedAttributes, structured_tags ? JSON.stringify(structured_tags) : null, enabled, latitude ?? null, longitude ?? null]
  );
  return result.rows[0];
});

// Cihaz silme
app.delete("/api/v1/devices/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };

  // KULLANICI GERİ BİLDİRİMİYLE EKLENDİ: silinen cihaz bir vCenter/ESXi ise (yani
  // vmware_source_device_id olarak sahip olduğu device_groups varsa), o gruplardaki
  // TÜM host cihazlarını da SİL -- aksi halde bu host'lar (ve üzerlerindeki
  // kurallar/alarmlar) öksüz kalır, sessizce ortada kalırlardı (canlı testte
  // gözlemlendi -- test cihazlarını elle silmemiz gerekmişti).
  const orphanHosts = await pool.query(
    `SELECT DISTINCT dgm.device_id
     FROM device_groups dg
     JOIN device_group_members dgm ON dgm.device_group_id = dg.id
     WHERE dg.vmware_source_device_id = $1`,
    [id]
  );
  if (orphanHosts.rows.length > 0) {
    const hostIds = orphanHosts.rows.map((r) => r.device_id);
    await pool.query(`DELETE FROM devices WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [auth.tenantId, hostIds]);
  }

  await pool.query(`DELETE FROM devices WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});

// Toplu silme (mass update — Zabbix'teki "mass update" mantığı)
// GÜVENLİK DÜZELTMESİ: tekil silme (DELETE /devices/:id) canEditDevices kontrolü yaparken
// bu endpoint hiç yapmıyordu — düzenleme izni olmayan herhangi bir kimliği doğrulanmış
// kullanıcı tüm cihazları toplu silebiliyordu.
app.post("/api/v1/devices/bulk-delete", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const body = request.body as { ids: string[] };
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return reply.status(400).send({ error: "ids listesi gerekli" });
  }

  // Tekil silme (yukarıdaki DELETE /devices/:id) ile AYNI mantık -- silinen
  // cihazlardan herhangi biri bir vCenter/ESXi ise, o vCenter'ın host'larını da sil.
  const orphanHosts = await pool.query(
    `SELECT DISTINCT dgm.device_id
     FROM device_groups dg
     JOIN device_group_members dgm ON dgm.device_group_id = dg.id
     WHERE dg.vmware_source_device_id = ANY($1::uuid[])`,
    [body.ids]
  );
  if (orphanHosts.rows.length > 0) {
    const hostIds = orphanHosts.rows.map((r) => r.device_id);
    await pool.query(`DELETE FROM devices WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [auth.tenantId, hostIds]);
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
  // GERÇEK EKSİKLİK (dashboard widget'ları incelenirken bulundu): template_items.unit
  // hiçbir zaman bu endpoint'ten dönmüyordu -- GraphWidget'ın Y ekseninde "%", "ms",
  // "Mbps" gibi bir birim göstermesi mümkün değildi (sadece ham sayı).
  const itemMeta = new Map<string, { data_type: string; is_table: boolean; value_map_id: string | null; unit: string | null }>();

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
        `SELECT DISTINCT ON (metric_name) metric_name, data_type, is_table, value_map_id, unit
         FROM template_items WHERE template_id = ANY($1::uuid[])
         ORDER BY metric_name, id`,
        [templateIds]
      );
      for (const row of itemsResult.rows) {
        itemMeta.set(row.metric_name, { data_type: row.data_type, is_table: row.is_table, value_map_id: row.value_map_id, unit: row.unit });
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

  // template_item birim taşımıyorsa (baseline poller'in ürettiği, hiçbir template_item'a
  // karşılık gelmeyen if_in_octets/cpu_load_1min/memory_used_percent gibi metrikler),
  // snmpPoller.ts'in metrics.unit'e YAZDIĞI ham değere geri düşülür -- en son yazılan
  // (muhtemelen en güncel) değer kullanılır.
  const rawUnits = await pool.query(
    `SELECT DISTINCT ON (metric_name) metric_name, unit
     FROM metrics WHERE tenant_id = $1 AND device_id = $2 AND time >= now() - interval '24 hours' AND unit IS NOT NULL
     ORDER BY metric_name, time DESC`,
    [auth.tenantId, query.device_id]
  );
  const rawUnitMap = new Map(rawUnits.rows.map((r) => [r.metric_name, r.unit]));

  // Value map incelemesi: template_item'a hiç bağlı olmayan baseline metrikler
  // (if_oper_status gibi) yukarıdaki itemMeta'dan value_map_id ALAMAZ -- bunlar
  // için metric_value_maps'teki tenant+metric_name eşlemesi YEDEK olarak kullanılır.
  const metricValueMaps = await pool.query(
    `SELECT metric_name, value_map_id FROM metric_value_maps WHERE tenant_id = $1`,
    [auth.tenantId]
  );
  const metricValueMapMap = new Map(metricValueMaps.rows.map((r) => [r.metric_name, r.value_map_id]));
  const statusSuffixIds = await getStatusSuffixValueMapIds(auth.tenantId);

  return result.rows.map((r) => {
    const meta = itemMeta.get(r.metric_name);
    const hasMultipleInterfaces = (interfaceCountMap.get(r.metric_name) ?? 0) > 1;
    return {
      metric_name: r.metric_name,
      interface: r.interface,
      data_type: meta?.data_type ?? "gauge",
      is_table: (meta?.is_table ?? false) || hasMultipleInterfaces,
      value_map_id: meta?.value_map_id ?? metricValueMapMap.get(r.metric_name) ?? resolveStatusSuffixValueMapId(r.metric_name, statusSuffixIds) ?? null,
      unit: meta?.unit ?? rawUnitMap.get(r.metric_name) ?? null
    };
  });
});

// GERÇEK EKSİKLİK (kullanıcı bulundu): top_n/status_grid/host_performance_table
// gibi TEK bir cihaza değil bir host grubuna (ya da tüm cihazlara) göre çalışan
// widget'ların ayar formunda metrik adı serbest metin kutusuydu -- kullanıcı
// metrik adını EZBERDEN yazmak zorundaydı. /api/v1/metrics/names TEK bir
// device_id gerektiriyor, bu widget'lar için uygun değil -- bu endpoint,
// (opsiyonel) bir host grubundaki TÜM cihazlarda son 24 saatte görülen
// metrik adlarının birleşimini (DISTINCT) döner.
app.get("/api/v1/metrics/names-summary", async (request) => {
  const auth = (request as any).auth;
  const query = request.query as { device_group_id?: string };

  let sql = `SELECT DISTINCT metric_name FROM metrics WHERE tenant_id = $1 AND time >= now() - interval '24 hours'`;
  const params: any[] = [auth.tenantId];
  if (query.device_group_id) {
    sql += ` AND device_id IN (SELECT device_id FROM device_group_members WHERE device_group_id = $2)`;
    params.push(query.device_group_id);
  }
  sql += ` ORDER BY metric_name`;

  const result = await pool.query(sql, params);
  return result.rows.map((r) => r.metric_name);
});

// ============ ALERTS ============
app.get("/api/v1/alerts", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
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
    anomaly_only?: string;
    predictive_only?: string;
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
  if (query.anomaly_only === "true") {
    conditions.push("a.is_anomaly = true");
  }
  if (query.predictive_only === "true") {
    conditions.push("a.is_predictive = true");
  }

  // FAZ 3: cihaz-grubu erişimi (deny) + tag filtresi. Devices-list'teki aynı
  // desen -- kullanıcının hiç grup üyeliği/izin tanımı yoksa eski davranış
  // korunur (kısıtlama yok).
  const auth_deviceGroupAccess = await resolveDeviceGroupAccess(auth.userId);
  const hasGroupRestrictions = Object.keys(auth_deviceGroupAccess).length > 0;
  if (hasGroupRestrictions) {
    const allowedGroupIds = Object.entries(auth_deviceGroupAccess)
      .filter(([, permission]) => permission !== "deny")
      .map(([groupId]) => groupId);
    if (allowedGroupIds.length === 0) {
      conditions.push("1 = 0");
    } else {
      conditions.push(`a.device_id IN (SELECT device_id FROM device_group_members WHERE device_group_id = ANY($${paramIndex}::uuid[]))`);
      params.push(allowedGroupIds);
      paramIndex++;
    }
  }
  const tagRestrictions = await resolveTagRestrictions(auth.userId);
  const hasTagRestrictions = Array.from(tagRestrictions.values()).some((f) => f !== null);
  // GUVENLIK: sortColumn kullanici girdisinden (query.sort) geliyor ama SADECE bu
  // whitelist'teki sabit SQL parcalarindan biri secilebiliyor -- dogrudan kullanici
  // girdisi SQL'e hic enjekte edilmiyor, bu yuzden injection riski yok.
  const SORT_COLUMNS: Record<string, string> = {
    triggered_at: "a.triggered_at",
    duration: "a.triggered_at",
    // GERÇEK HATA DÜZELTMESİ: 'critical' seviyesi sonradan eklendiğinde bu CASE
    // güncellenmemişti -- ELSE 0'a düşüp en düşük öncelikliymiş gibi (info'nun
    // bile altında) sıralanıyordu. notify.ts'teki SEVERITY_RANK ile aynı sıraya
    // getirildi (bkz. alarm-engine/src/notify.ts).
    severity: "CASE a.severity WHEN 'critical' THEN 5 WHEN 'disaster' THEN 4 WHEN 'high' THEN 3 WHEN 'average' THEN 2 WHEN 'warning' THEN 1 WHEN 'info' THEN 0 ELSE 0 END"
  };
  const sortColumn = SORT_COLUMNS[query.sort || "triggered_at"] || SORT_COLUMNS.triggered_at;
  const sortOrder = query.order === "asc" ? "ASC" : "DESC";
  // Excel/CSV export'u icin daha yuksek ust sinir (varsayilan hala 50, degismedi).
  const limit = Math.min(Number(query.limit) || 50, 5000);
  const page = Math.max(Number(query.page) || 1, 1);
  const offset = (page - 1) * limit;

  // FAZ 3: tag filtresi aktifse (kullanıcının en az bir grubu en az bir device_group
  // için tag filtresi tanımlamışsa), SQL seviyesinde LIMIT/OFFSET uygulayamayız --
  // önce geniş bir aday küme çekilip JS'te filtrelenip SONRA sayfalanması gerekiyor
  // (tag eşleşmesi cihazın ÜYE OLDUĞU TÜM device_group'lara bakan bir mantık,
  // basit bir SQL WHERE koşuluna indirgemek yerine burada netlik/doğruluk tercih
  // edildi). Tag filtresi TANIMLI OLMAYAN çoğunluk kullanıcı için performans/davranış
  // AYNEN korunuyor (bu dal hiç çalışmıyor).
  if (hasTagRestrictions) {
    const candidateResult = await pool.query(
      `SELECT a.id, a.device_id, d.name as device_name, r.metric_name, a.triggered_at, a.resolved_at, a.severity, a.message,
              a.acknowledged_at, a.acknowledged_by, a.tags, a.is_anomaly, a.is_predictive,
              (SELECT COUNT(*)::int FROM alerts a2 WHERE a2.rule_id = a.rule_id AND a2.device_id = a.device_id
               AND a2.triggered_at >= now() - interval '7 days') as recurrence_count,
              COALESCE((SELECT array_agg(device_group_id) FROM device_group_members WHERE device_id = a.device_id), ARRAY[]::uuid[]) as device_group_ids
       FROM alerts a
       JOIN alert_rules r ON a.rule_id = r.id
       LEFT JOIN devices d ON a.device_id = d.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY ${sortColumn} ${sortOrder} LIMIT 5000`,
      params
    );
    const filtered = candidateResult.rows.filter((row) =>
      alertPassesTagRestrictions(row.tags, row.device_group_ids || [], tagRestrictions)
    );
    const total = filtered.length;
    const items = filtered.slice(offset, offset + limit).map(({ device_group_ids, ...rest }) => rest);
    return { items, total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) };
  }

  const result = await pool.query(
    `SELECT a.id, a.device_id, d.name as device_name, r.metric_name, a.triggered_at, a.resolved_at, a.severity, a.message,
            a.acknowledged_at, a.acknowledged_by, a.tags, a.is_anomaly, a.is_predictive,
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
app.get("/api/v1/alerts/severity-summary", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
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

  // FAZ 3: ana listeyle TUTARLI cihaz-grubu erişim kısıtlaması (deny). Tag
  // filtresi burada uygulanmıyor (bu sadece bir sayaç özeti, tag-bazlı ayrımın
  // getirisi düşük) -- ana listedeki gerçek alarm satırları zaten tag filtresine
  // tabi, sadece bu özet sayaçta hafif bir tutarsızlık olabilir (bilinen sınırlama).
  const deviceGroupAccess = await resolveDeviceGroupAccess(auth.userId);
  if (Object.keys(deviceGroupAccess).length > 0) {
    const allowedGroupIds = Object.entries(deviceGroupAccess)
      .filter(([, permission]) => permission !== "deny")
      .map(([groupId]) => groupId);
    if (allowedGroupIds.length === 0) {
      conditions.push("1 = 0");
    } else {
      conditions.push(`a.device_id IN (SELECT device_id FROM device_group_members WHERE device_group_id = ANY($${paramIndex}::uuid[]))`);
      params.push(allowedGroupIds);
      paramIndex++;
    }
  }

  const result = await pool.query(
    `SELECT severity, COUNT(*)::int as count FROM alerts a WHERE ${conditions.join(" AND ")} GROUP BY severity`,
    params
  );
  return result.rows;
});


// Bir alarmın tüm detayı: kural tanımı, cihaz, yorumlar, bildirim gönderim geçmişi,
// bu alarm yüzünden bastırılmış (suppress edilmiş) diğer alarmlar.
// BÜTÜNLÜK DÜZELTMESİ: liste endpoint'inde (GET /alerts) uygulanan cihaz-grubu
// (deny) + tag filtresi kısıtlamaları, TEK BİR alarma (id ile) erişimde HİÇ
// uygulanmıyordu -- bir kullanıcı, listede göremediği bir alarmı ID'sini
// bilerek/tahmin ederek görebilir, onaylayabilir, severity'sini değiştirebilirdi.
async function alertIsAccessibleToUser(auth: any, alertRow: { device_id: string; tags: any }): Promise<boolean> {
  const deviceGroupAccess = await resolveDeviceGroupAccess(auth.userId);
  if (Object.keys(deviceGroupAccess).length === 0) return true; // hiç grup kısıtlaması yok

  const memberResult = await pool.query(`SELECT device_group_id FROM device_group_members WHERE device_id = $1`, [alertRow.device_id]);
  const deviceGroupIds = memberResult.rows.map((r: any) => r.device_group_id);
  const allowedGroupIds = new Set(
    Object.entries(deviceGroupAccess).filter(([, p]) => p !== "deny").map(([gid]) => gid)
  );
  if (!deviceGroupIds.some((gid: string) => allowedGroupIds.has(gid))) return false;

  const tagRestrictions = await resolveTagRestrictions(auth.userId);
  return alertPassesTagRestrictions(alertRow.tags, deviceGroupIds, tagRestrictions);
}

app.get("/api/v1/alerts/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };

  const alertResult = await pool.query(
    `SELECT a.id, a.device_id, d.name as device_name, d.ip_address, d.device_type,
            a.rule_id, a.metric_name, a.condition, a.threshold, a.value, a.tags, a.is_anomaly, a.is_predictive,
            a.baseline_lower, a.baseline_upper,
            a.triggered_at, a.resolved_at, a.severity, a.message,
            a.acknowledged_at, a.acknowledged_by, u.email as acknowledged_by_email,
            a.resolved_manually_by, ru.email as resolved_manually_by_email,
            r.duration_seconds, r.active as rule_active, (r.template_rule_id IS NOT NULL) as from_template,
            a.last_escalation_step, ep.id as escalation_policy_id, ep.name as escalation_policy_name,
            (SELECT COUNT(*)::int FROM escalation_policy_steps eps WHERE eps.policy_id = ep.id) as escalation_step_count
     FROM alerts a
     LEFT JOIN devices d ON d.id = a.device_id
     LEFT JOIN alert_rules r ON r.id = a.rule_id
     LEFT JOIN escalation_policies ep ON ep.id = r.escalation_policy_id
     LEFT JOIN users u ON u.id = a.acknowledged_by
     LEFT JOIN users ru ON ru.id = a.resolved_manually_by
     WHERE a.tenant_id = $1 AND a.id = $2`,
    [auth.tenantId, id]
  );
  if (alertResult.rows.length === 0) return reply.status(404).send({ error: "Alarm bulunamadı" });
  const alert = alertResult.rows[0];
  if (!(await alertIsAccessibleToUser(auth, alert))) {
    return reply.status(404).send({ error: "Alarm bulunamadı" });
  }

  const commentsResult = await pool.query(
    `SELECT c.id, c.comment, c.created_at, u.email as user_email
     FROM alert_comments c JOIN users u ON u.id = c.user_id
     WHERE c.alert_id = $1 ORDER BY c.created_at ASC`,
    [id]
  );

  const deliveriesResult = await pool.query(
    `SELECT nd.id, nd.channel_type, nd.destination, nd.status, nd.error_message, nd.sent_at, nd.payload, mt.name as media_type_name
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

  // GÖRÜNÜRLÜK: tüm olayları (tetiklenme, bildirimler, üstlenme, notlar, çözülme)
  // TEK bir kronolojik zaman çizelgesinde birleştiriyoruz -- ayrı ayrı kutular
  // yerine, alarmın gerçek yaşam döngüsünü sırayla görebilmek için. Eskalasyon
  // bildirimleri, mesaj metnindeki "[Eskalasyon adım N]" öneki üzerinden (bkz.
  // notify.ts notifyEscalationStep) ayırt ediliyor.
  const timeline: any[] = [];
  timeline.push({ type: "triggered", timestamp: alert.triggered_at, value: alert.value, threshold: alert.threshold, condition: alert.condition });

  for (const d of deliveriesResult.rows) {
    const payload = d.payload || {};
    const bodyText: string = payload.type === "webhook" ? (payload.body?.message || "") : (payload.body || "");
    const escalationMatch = bodyText.match(/^\[Eskalasyon adım (\d+)\]/);
    timeline.push({
      type: escalationMatch ? "escalation_notification" : "notification",
      timestamp: d.sent_at,
      channel_type: d.channel_type,
      destination: d.destination,
      status: d.status,
      error_message: d.error_message,
      step_order: escalationMatch ? Number(escalationMatch[1]) : undefined
    });
  }

  for (const c of commentsResult.rows) {
    timeline.push({ type: "comment", timestamp: c.created_at, user_email: c.user_email, comment: c.comment });
  }

  if (alert.acknowledged_at) {
    timeline.push({ type: "acknowledged", timestamp: alert.acknowledged_at, user_email: alert.acknowledged_by_email });
  }
  if (alert.resolved_at) {
    timeline.push({ type: "resolved", timestamp: alert.resolved_at, user_email: alert.resolved_manually_by_email || undefined });
  }

  timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return {
    ...alert,
    comments: commentsResult.rows,
    notification_deliveries: deliveriesResult.rows,
    suppressed_by_this: suppressedByThisResult.rows,
    timeline
  };
});

app.post("/api/v1/alerts/:id/acknowledge", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };

  const existing = await pool.query(`SELECT device_id, tags FROM alerts WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  if (existing.rows.length === 0) return reply.status(404).send({ error: "Alarm bulunamadı" });
  if (!(await alertIsAccessibleToUser(auth, existing.rows[0]))) return reply.status(404).send({ error: "Alarm bulunamadı" });

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
  if (!hasPermission(auth, "alert_rules", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const parsed = BulkAcknowledgeSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  // BÜTÜNLÜK DÜZELTMESİ: liste endpoint'iyle AYNI cihaz-grubu (deny) kısıtlaması
  // burada da uygulanıyor -- aksi halde bir kullanıcı, erişimi olmayan bir
  // cihazın alarmını, ID'sini biliyorsa toplu onaylama ile üstlenebilirdi.
  // (Tag filtresi bulk işlemde performans/karmaşıklık dengesi gözetilerek
  // uygulanmadı -- tek tek onaylama (yukarıdaki endpoint) tam kontrol yapıyor.)
  const conditions = ["tenant_id = $2", "id = ANY($3::uuid[])"];
  const params: any[] = [auth.userId, auth.tenantId, parsed.data.ids];
  const deviceGroupAccess = await resolveDeviceGroupAccess(auth.userId);
  if (Object.keys(deviceGroupAccess).length > 0) {
    const allowedGroupIds = Object.entries(deviceGroupAccess).filter(([, p]) => p !== "deny").map(([gid]) => gid);
    if (allowedGroupIds.length === 0) {
      return { acknowledged: 0 };
    }
    conditions.push(`device_id IN (SELECT device_id FROM device_group_members WHERE device_group_id = ANY($4::uuid[]))`);
    params.push(allowedGroupIds);
  }

  const result = await pool.query(
    `UPDATE alerts SET acknowledged_at = now(), acknowledged_by = $1 WHERE ${conditions.join(" AND ")} RETURNING id`,
    params
  );
  return { acknowledged: result.rows.length };
});


app.delete("/api/v1/alerts/:id/acknowledge", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };

  const existing = await pool.query(`SELECT device_id, tags FROM alerts WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  if (existing.rows.length === 0) return reply.status(404).send({ error: "Alarm bulunamadı" });
  if (!(await alertIsAccessibleToUser(auth, existing.rows[0]))) return reply.status(404).send({ error: "Alarm bulunamadı" });

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
  severity: z.enum(["info", "warning", "average", "high", "disaster", "critical"])
});
// Bir alarmı manuel olarak "çözüldü" işaretler. ÖNEMLİ: bu, altta yatan koşulu
// düzeltmez -- metrik hâlâ eşiği aşıyorsa, alarm-engine bir sonraki turda bunu
// YENİ bir alarm olarak tekrar açar (bu KASITLI ve doğru davranıştır, Zabbix'in
// "manuel kapatma" özelliğiyle aynı mantık).
app.post("/api/v1/alerts/:id/resolve", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };

  const existing = await pool.query(`SELECT device_id, tags, resolved_at FROM alerts WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  if (existing.rows.length === 0) return reply.status(404).send({ error: "Alarm bulunamadı" });
  if (!(await alertIsAccessibleToUser(auth, existing.rows[0]))) return reply.status(404).send({ error: "Alarm bulunamadı" });
  if (existing.rows[0].resolved_at) return reply.status(409).send({ error: "Alarm zaten çözülmüş" });

  const result = await pool.query(
    `UPDATE alerts SET resolved_at = now(), resolved_manually_by = $1 WHERE tenant_id = $2 AND id = $3 RETURNING id, resolved_at`,
    [auth.userId, auth.tenantId, id]
  );
  return result.rows[0];
});

app.patch("/api/v1/alerts/:id/severity", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const parsed = UpdateAlertSeveritySchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const existing = await pool.query(`SELECT device_id, tags FROM alerts WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  if (existing.rows.length === 0) return reply.status(404).send({ error: "Alarm bulunamadı" });
  if (!(await alertIsAccessibleToUser(auth, existing.rows[0]))) return reply.status(404).send({ error: "Alarm bulunamadı" });

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
  if (!hasPermission(auth, "alert_rules", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const parsed = AddCommentSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const alertCheck = await pool.query(`SELECT id, device_id, tags FROM alerts WHERE id = $1 AND tenant_id = $2`, [id, auth.tenantId]);
  if (alertCheck.rows.length === 0) return reply.status(404).send({ error: "Alarm bulunamadı" });
  if (!(await alertIsAccessibleToUser(auth, alertCheck.rows[0]))) return reply.status(404).send({ error: "Alarm bulunamadı" });

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
  severity: z.enum(["info", "warning", "average", "high", "disaster", "critical"]).default("warning")
});

app.get("/api/v1/alert-rules", async (request) => {
  const auth = (request as any).auth;
  // Anomali Tespiti: is_anomaly=true olan "gölge" kurallar (checkDeviceReachability'nin
  // heartbeat kurallarıyla AYNI mantık) kullanıcıya HİÇ gösterilmemeli -- bunlar
  // backend'e özel, teknik detaylardır. anomaly_enabled, GERÇEK kuralın kendi
  // opt-out durumunu taşır (gölge kuraldan bağımsız).
  const result = await pool.query(
    `SELECT r.id, r.metric_name, r.condition, r.threshold, r.duration_seconds, r.device_id, r.active, r.severity, r.anomaly_enabled, r.anomaly_sigma, r.anomaly_seasonal, r.predictive_enabled, r.predictive_horizon_hours, d.name as device_name
     FROM alert_rules r
     LEFT JOIN devices d ON r.device_id = d.id
     WHERE r.tenant_id = $1 AND r.is_heartbeat = false AND r.is_anomaly = false AND r.is_predictive = false
     ORDER BY r.metric_name`,
    [auth.tenantId]
  );
  return result.rows;
});

app.post("/api/v1/alert-rules", async (request, reply) => {
  const auth = (request as any).auth;
  // GÜVENLİK DÜZELTMESİ: bu endpoint'te daha önce yetki kontrolü hiç yoktu -- kimliği
  // doğrulanmış herhangi bir kullanıcı (canEditAlertRules olmasa bile) kural oluşturabiliyordu.
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const parsed = CreateRuleSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { metric_name, condition, threshold, duration_seconds, device_id, severity } = parsed.data;

  // BUG DÜZELTMESİ: bu, aynı işi yapan POST /api/v1/devices/:id/alert-rules endpoint'inde
  // dün düzeltilen "aynı cihaz+metrik+eşik için tekrar kural" bug'ının İKİNCİ giriş noktası
  // idi -- düzeltme oraya uygulanmış ama buraya hiç uygulanmamıştı. Aynı duplicate kontrolü
  // burada da uygulanıyor (device_id NULL olabileceği için IS NOT DISTINCT FROM kullanılır --
  // "= NULL" SQL'de her zaman false/unknown döner, iki NULL'u eşit saymaz).
  const existingRule = await pool.query(
    `SELECT id FROM alert_rules
     WHERE tenant_id = $1 AND device_id IS NOT DISTINCT FROM $2
       AND metric_name = $3 AND condition = $4 AND threshold = $5`,
    [auth.tenantId, device_id || null, metric_name, condition, threshold]
  );
  if (existingRule.rows.length > 0) {
    return reply.status(409).send({ error: "Bu metrik/koşul/eşik için zaten bir kural tanımlı" });
  }

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
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
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

// APM Adım 5: trace_id (OTLP hex string, 32 karakter) ve service_name
// (kullanıcı girdisi) için güvenli doğrulama -- safeDeviceIdFilter ile AYNI
// mantık (whitelist regex + tek tırnaklı literal, queryClickHouse parametreli
// sorgu desteklemediği için).
const TRACE_ID_RE = /^[0-9a-f]{32}$/i;
function isSafeTraceId(traceId: string | undefined): traceId is string {
  return !!traceId && TRACE_ID_RE.test(traceId);
}
// service_name serbest metin olabilir (OTel service.name attribute'u) ama
// SQL injection'a karşı tek tırnağı escape ediyoruz (ClickHouse'da ' -> '').
function escapeClickhouseString(value: string): string {
  return value.replace(/'/g, "''");
}

// RED metrikleri (Rate, Errors, Duration) -- APM'in standart servis genel
// bakış görünümü. Her servis için: istek oranı (dakikada), hata oranı (%),
// p50/p95/p99 gecikme. Sadece KÖK span'leri (parent_span_id boş olanlar,
// yani her trace'in giriş noktası) sayıyoruz -- yoksa iç span'ler de "istek"
// gibi sayılıp Rate anlamsızlaşırdı.
app.get("/api/v1/apm/services", async (request, reply) => {
  const auth = (request as any).auth;
  const query = request.query as { hours?: string };
  const hours = Math.min(Number(query.hours) || 1, 168);
  try {
    const rows = await queryClickHouse(`
      SELECT
        service_name,
        count(*) AS request_count,
        round(count(*) / ${hours} / 60, 2) AS requests_per_min,
        round(100.0 * countIf(status_code = 2) / count(*), 2) AS error_rate_pct,
        round(quantile(0.50)(duration_ms), 1) AS p50_ms,
        round(quantile(0.95)(duration_ms), 1) AS p95_ms,
        round(quantile(0.99)(duration_ms), 1) AS p99_ms
      FROM traces
      WHERE tenant_id = '${auth.tenantId}' AND timestamp >= now() - INTERVAL ${hours} HOUR
      GROUP BY service_name
      ORDER BY request_count DESC
    `);

    // GERÇEK EKSİKLİK: her APM servisi apm-sync/service tarafından zaten
    // devices tablosuna (device_type='service') yazılıyor ve service_host
    // bağlantısıyla RCA motoruna bağlı -- ama bu endpoint device_id'yi hiç
    // döndürmüyordu, frontend servisi cihaz sayfasına linkleyemiyordu.
    // ClickHouse (trace verisi) ile Postgres (cihaz kaydı) ayrı motorlar
    // olduğu için burada ikinci bir Postgres sorgusuyla eşleniyor.
    const serviceNames = rows.map((r: any) => r.service_name);
    if (serviceNames.length > 0) {
      const deviceResult = await pool.query(
        `SELECT id, attributes->>'apm_service_name' as service_name
         FROM devices WHERE tenant_id = $1 AND device_type = 'service' AND attributes->>'apm_service_name' = ANY($2)`,
        [auth.tenantId, serviceNames]
      );
      const deviceIdByService = new Map(deviceResult.rows.map((d) => [d.service_name, d.id]));
      for (const row of rows as any[]) {
        row.device_id = deviceIdByService.get(row.service_name) ?? null;
      }
    }

    return rows;
  } catch (err: any) {
    request.log.error(err);
    return reply.status(500).send({ error: "APM servis sorgusu başarısız" });
  }
});

// GERÇEK EKSİKLİK: /apm/services SADECE seçili aralığın toplu değerini
// gösteriyordu -- gecikme/hata oranı zaman içinde artıyor mu sorusuna hiçbir
// görsel yanıt yoktu (dashboard'daki her şeyin trend gösterdiği bu oturumun
// temasıyla çelişiyordu). alert-trend widget'ındaki AYNI dinamik bucket
// deseni (<=48 saat: saatlik, aksi halde günlük) kullanılıyor.
app.get("/api/v1/apm/services/:serviceName/trend", async (request, reply) => {
  const auth = (request as any).auth;
  const { serviceName } = request.params as { serviceName: string };
  const query = request.query as { hours?: string };
  const hours = Math.min(Number(query.hours) || 6, 168);
  const bucketFn = hours <= 48 ? "toStartOfHour" : "toStartOfDay";

  try {
    const rows = await queryClickHouse(`
      SELECT
        ${bucketFn}(timestamp) AS bucket,
        count(*) AS request_count,
        round(100.0 * countIf(status_code = 2) / count(*), 2) AS error_rate_pct,
        round(quantile(0.95)(duration_ms), 1) AS p95_ms
      FROM traces
      WHERE tenant_id = '${auth.tenantId}' AND service_name = '${escapeClickhouseString(serviceName)}'
        AND timestamp >= now() - INTERVAL ${hours} HOUR
      GROUP BY bucket
      ORDER BY bucket ASC
    `);
    return rows;
  } catch (err: any) {
    request.log.error(err);
    return reply.status(500).send({ error: "APM trend sorgusu başarısız" });
  }
});

// Trace arama -- servis adı ve/veya minimum süre filtresiyle, en son
// trace'lerin KÖK span'lerini listeler (her trace'in özet satırı).
app.get("/api/v1/apm/traces", async (request, reply) => {
  const auth = (request as any).auth;
  const query = request.query as { service_name?: string; min_duration_ms?: string; hours?: string; limit?: string; errors_only?: string };
  const hours = Math.min(Number(query.hours) || 1, 168);
  const limit = Math.min(Number(query.limit) || 50, 200);
  const minDuration = Number(query.min_duration_ms) || 0;

  const conditions = [`tenant_id = '${auth.tenantId}'`, `timestamp >= now() - INTERVAL ${hours} HOUR`, `parent_span_id = ''`];
  if (query.service_name) {
    conditions.push(`service_name = '${escapeClickhouseString(query.service_name)}'`);
  }
  if (minDuration > 0) {
    conditions.push(`duration_ms >= ${minDuration}`);
  }
  // RED'in "Errors" boyutunu ayıklamak için -- öncesinde kullanıcı hatalı
  // trace'leri bulmak için tüm listeyi manuel taramak zorundaydı.
  if (query.errors_only === "true") {
    conditions.push(`status_code = 2`);
  }

  try {
    // GERÇEK HATA (canlı testte bulundu): ClickHouse, Postgres'in aksine korele
    // alt sorguları (t2.trace_id = traces.trace_id) satır-satır ilişkilendirmiyor
    // -- her satırda aynı (yanlış) span_count değeri döndü. Düzeltme: ayrı bir
    // GROUP BY alt sorgusu + JOIN (ClickHouse'un iyi desteklediği desen).
    const rows = await queryClickHouse(`
      SELECT root.trace_id, root.service_name, root.operation_name, root.timestamp,
             root.duration_ms, root.status_code, counts.span_count
      FROM (
        SELECT trace_id, service_name, operation_name, timestamp, duration_ms, status_code
        FROM traces
        WHERE ${conditions.join(" AND ")}
        ORDER BY timestamp DESC
        LIMIT ${limit}
      ) AS root
      INNER JOIN (
        SELECT trace_id, count(*) AS span_count
        FROM traces
        WHERE tenant_id = '${auth.tenantId}' AND timestamp >= now() - INTERVAL ${hours} HOUR
        GROUP BY trace_id
      ) AS counts ON counts.trace_id = root.trace_id
      ORDER BY root.timestamp DESC
    `);
    return rows;
  } catch (err: any) {
    request.log.error(err);
    return reply.status(500).send({ error: "Trace arama başarısız" });
  }
});

// Trace detayı -- tek bir trace_id'ye ait TÜM span'ler (waterfall görünümü
// için), zaman sırasına göre. Frontend, parent_span_id'yi kullanarak
// hiyerarşik/girintili bir görünüm inşa edecek.
app.get("/api/v1/apm/traces/:traceId", async (request, reply) => {
  const auth = (request as any).auth;
  const { traceId } = request.params as { traceId: string };
  if (!isSafeTraceId(traceId)) return reply.status(400).send({ error: "Geçersiz trace_id formatı" });

  try {
    const rows = await queryClickHouse(`
      SELECT span_id, parent_span_id, service_name, operation_name, timestamp, duration_ms, status_code, kind, attributes
      FROM traces
      WHERE tenant_id = '${auth.tenantId}' AND trace_id = '${traceId}'
      ORDER BY timestamp ASC
    `);
    if (rows.length === 0) return reply.status(404).send({ error: "Trace bulunamadı" });
    return { trace_id: traceId, spans: rows };
  } catch (err: any) {
    request.log.error(err);
    return reply.status(500).send({ error: "Trace detay sorgusu başarısız" });
  }
});

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

  // GERÇEK EKSİKLİK DÜZELTMESİ: arayüz metriklerinde sadece ham teknik isim
  // (ör. "Gi1/0/1") gösteriliyordu -- ağ yöneticisinin porta verdiği anlamlı
  // açıklama (ifAlias, ör. "Kenar_Switch_Uplink") hiç yoktu. Artık
  // device_interface_metadata'dan LEFT JOIN ile ekleniyor (yoksa null).
  const result = await pool.query(
    `SELECT DISTINCT ON (m.metric_name, m.interface)
       m.metric_name, m.interface, m.value, m.unit, m.time, dim.alias as interface_alias
     FROM metrics m
     LEFT JOIN device_interface_metadata dim ON dim.device_id = m.device_id AND dim.interface = m.interface
     WHERE m.tenant_id = $1 AND m.device_id = $2 AND m.time >= now() - interval '1 hour'
     ORDER BY m.metric_name, m.interface, m.time DESC`,
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
// LLDP/CDP OTOMATİK KEŞİF: npm-service'in periyodik keşif turlarında çağırdığı
// internal endpoint. Komşunun yönetim IP'sini bizim devices tablomuzdaki bir
// cihazla eşleştirip (eşleşme yoksa sessizce atlanır -- henüz sistemde kayıtlı
// olmayan bir komşu, hata değil), device_links'e UPSERT eder. Aynı iki cihaz
// arasında BİRDEN FAZLA fiziksel port bağlantısı olabileceği için (LAG/trunk),
// interface çifti de benzersizlik anahtarının parçası (bkz. migration 079).
const DiscoveredLinkSchema = z.object({
  tenant_id: z.string().uuid(),
  device_id: z.string().uuid(),
  local_interface: z.string().optional(),
  neighbor_management_ip: z.string(),
  neighbor_interface: z.string().optional(),
  method: z.enum(["lldp", "cdp"])
});
app.post("/api/v1/internal/topology/discovered-links", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const parsed = DiscoveredLinkSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { tenant_id, device_id, local_interface, neighbor_management_ip, neighbor_interface, method } = parsed.data;

  const neighborResult = await pool.query(
    `SELECT id FROM devices WHERE tenant_id = $1 AND ip_address = $2`,
    [tenant_id, neighbor_management_ip]
  );
  if (neighborResult.rows.length === 0) {
    // Komşu, bizim sistemimizde henüz kayıtlı bir cihaz değil -- görmezden gel
    // (hata değil, LLDP her komşuyu görür ama biz sadece izlediğimiz cihazları
    // topoloji grafiğinde gösterebiliriz).
    return { matched: false };
  }
  const neighborId = neighborResult.rows[0].id;
  if (neighborId === device_id) return { matched: false }; // kendi kendine bağlantı (loopback) anlamsız

  await pool.query(
    `INSERT INTO device_links (tenant_id, device_a_id, device_b_id, interface_a, interface_b, discovery_method, discovered_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (tenant_id, LEAST(device_a_id, device_b_id), GREATEST(device_a_id, device_b_id), COALESCE(interface_a, ''), COALESCE(interface_b, ''))
     DO UPDATE SET discovered_at = now(), discovery_method = $6`,
    [tenant_id, device_id, neighborId, local_interface || null, neighbor_interface || null, method]
  );
  return { matched: true, neighbor_device_id: neighborId };
});

// Dashboard, npm-service'in Docker network dışına kapalı olan HTTP API'sine
// DOĞRUDAN erişemez -- bu endpoint basit bir proxy görevi görür (JWT ile korumalı,
// npm-service'in internal HTTP portuna Docker network üzerinden istek atar).
const NPM_SERVICE_URL = process.env.NPM_SERVICE_URL || "http://npm-service:3100";
app.post("/api/v1/topology/lldp-scan-now", async (request, reply) => {
  try {
    const npmResponse = await fetch(`${NPM_SERVICE_URL}/api/v1/discovery/lldp-scan-now`, { method: "POST" });
    if (!npmResponse.ok) return reply.status(502).send({ error: "npm-service yanıt vermedi" });
    return reply.status(202).send({ started: true });
  } catch (err) {
    return reply.status(502).send({ error: "npm-service'e ulaşılamadı" });
  }
});

// ============================================================
// AĞ KEŞFİ (Network Discovery) -- kural-bazlı, zamanlanabilir subnet tarama.
// Eski tek-seferlik, /24 ile sınırlı, tarayıcıda saklanmayan "subnet scan"
// modalının yerini alıyor (bkz. infra/sql/095_network_discovery_rules.sql).
// Gerçek ping/SNMP taraması npm-service'te çalışır (Docker network'e o erişir);
// core SADECE tenant-scoped kuralı/adayları saklar ve npm-service'i tetikler --
// LLDP keşfinin device_links'i core'a POST etmesiyle AYNI iş bölümü, ters yönde.
// ============================================================

const DiscoveryRuleV3Schema = z.object({
  username: z.string().min(1),
  level: z.enum(["noAuthNoPriv", "authNoPriv", "authPriv"]),
  authProtocol: z.enum(["md5", "sha", "sha224", "sha256", "sha384", "sha512"]).optional(),
  authKey: z.string().optional(),
  privProtocol: z.enum(["des", "aes", "aes256b", "aes256r"]).optional(),
  privKey: z.string().optional()
});
// GERÇEK EKSİKLİK (canlı testte bulundu): CIDR sözdizimi öncesinde SADECE
// npm-service'te, tarama ÇALIŞTIRILDIĞINDA doğrulanıyordu -- bozuk bir CIDR'lı
// kural sorunsuzca oluşturuluyor, sadece "Şimdi çalıştır"da 502 veriyordu; bir
// ZAMANLANMIŞ kuralda bu hata kullanıcıya hiç görünmeden sessizce (sadece
// console.error ile) sonsuza dek başarısız olurdu. Artık oluşturma/güncelleme
// anında (Zabbix'in discovery rule doğrulamasıyla AYNI ilke) reddediliyor.
const CIDR_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
function isValidCidr(cidr: string): boolean {
  const match = cidr.trim().match(CIDR_REGEX);
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  return octets.every((o) => o >= 0 && o <= 255) && prefix >= 0 && prefix <= 32;
}
const CidrRangesSchema = z.array(z.string().min(1)).min(1).refine(
  (cidrs) => cidrs.every(isValidCidr),
  { message: "Geçersiz CIDR formatı (örn. 192.168.1.0/24 bekleniyor)" }
);

const CreateDiscoveryRuleSchema = z.object({
  name: z.string().min(1),
  cidr_ranges: CidrRangesSchema,
  snmp_version: z.enum(["v2c", "v3"]).default("v2c"),
  snmp_community: z.string().optional(),
  snmp_v3: DiscoveryRuleV3Schema.optional(),
  // NULL/gönderilmez = sadece manuel ("Şimdi çalıştır"); dolu = otomatik periyodik.
  schedule_interval_hours: z.number().int().min(1).max(8760).nullable().optional()
});

// authKey/privKey ASLA frontend'e geri dönmez -- macro value_type='secret'
// ile AYNI "write-only secret" ilkesi.
function serializeDiscoveryRule(row: any) {
  return {
    id: row.id,
    name: row.name,
    cidr_ranges: row.cidr_ranges,
    snmp_version: row.snmp_version,
    snmp_community: row.snmp_community,
    snmp_v3_username: row.snmp_v3_username,
    snmp_v3_level: row.snmp_v3_level,
    snmp_v3_auth_protocol: row.snmp_v3_auth_protocol,
    snmp_v3_priv_protocol: row.snmp_v3_priv_protocol,
    schedule_interval_hours: row.schedule_interval_hours,
    last_run_at: row.last_run_at,
    active: row.active,
    created_at: row.created_at
  };
}

app.get("/api/v1/discovery-rules", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "devices", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const result = await pool.query(`SELECT * FROM discovery_rules WHERE tenant_id = $1 ORDER BY created_at DESC`, [auth.tenantId]);
  return result.rows.map(serializeDiscoveryRule);
});

app.post("/api/v1/discovery-rules", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const parsed = CreateDiscoveryRuleSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const d = parsed.data;
  if (d.snmp_version === "v3" && !d.snmp_v3) {
    return reply.status(400).send({ error: "snmp_version=v3 için snmp_v3 alanı zorunlu" });
  }

  const authKeyEncrypted = d.snmp_v3?.authKey ? encryptSecret(d.snmp_v3.authKey) : null;
  const privKeyEncrypted = d.snmp_v3?.privKey ? encryptSecret(d.snmp_v3.privKey) : null;

  const result = await pool.query(
    `INSERT INTO discovery_rules
       (tenant_id, name, cidr_ranges, snmp_version, snmp_community,
        snmp_v3_username, snmp_v3_level, snmp_v3_auth_protocol, snmp_v3_auth_key_encrypted,
        snmp_v3_priv_protocol, snmp_v3_priv_key_encrypted, schedule_interval_hours, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      auth.tenantId, d.name, d.cidr_ranges, d.snmp_version, d.snmp_community || null,
      d.snmp_v3?.username || null, d.snmp_v3?.level || null, d.snmp_v3?.authProtocol || null, authKeyEncrypted,
      d.snmp_v3?.privProtocol || null, privKeyEncrypted, d.schedule_interval_hours ?? null, auth.userId
    ]
  );
  return reply.status(201).send(serializeDiscoveryRule(result.rows[0]));
});

const UpdateDiscoveryRuleSchema = CreateDiscoveryRuleSchema.partial().extend({ active: z.boolean().optional() });
app.patch("/api/v1/discovery-rules/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const parsed = UpdateDiscoveryRuleSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const d = parsed.data;

  const existing = await pool.query(`SELECT * FROM discovery_rules WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  if (existing.rows.length === 0) return reply.status(404).send({ error: "Kural bulunamadı" });
  const current = existing.rows[0];

  // authKey/privKey sadece GÖNDERİLMİŞSE güncellenir -- boş bırakılırsa mevcut
  // şifreli değer korunur (macro secret PATCH'iyle AYNI "boşsa değişmez" ilkesi).
  const authKeyEncrypted = d.snmp_v3?.authKey ? encryptSecret(d.snmp_v3.authKey) : current.snmp_v3_auth_key_encrypted;
  const privKeyEncrypted = d.snmp_v3?.privKey ? encryptSecret(d.snmp_v3.privKey) : current.snmp_v3_priv_key_encrypted;
  // schedule_interval_hours üç durumlu (gönderilmedi=koru, null=manuele döndür,
  // sayı=güncelle) -- düz COALESCE bunu ayıramaz (null'u "koru" ile karıştırır),
  // bu yüzden ayrı bir "gönderildi mi" bayrağı kullanılıyor.
  const scheduleWasSent = d.schedule_interval_hours !== undefined;

  const result = await pool.query(
    `UPDATE discovery_rules SET
       name = COALESCE($1, name),
       cidr_ranges = COALESCE($2, cidr_ranges),
       snmp_version = COALESCE($3, snmp_version),
       snmp_community = COALESCE($4, snmp_community),
       snmp_v3_username = COALESCE($5, snmp_v3_username),
       snmp_v3_level = COALESCE($6, snmp_v3_level),
       snmp_v3_auth_protocol = COALESCE($7, snmp_v3_auth_protocol),
       snmp_v3_auth_key_encrypted = $8,
       snmp_v3_priv_protocol = COALESCE($9, snmp_v3_priv_protocol),
       snmp_v3_priv_key_encrypted = $10,
       schedule_interval_hours = CASE WHEN $11 THEN $12 ELSE schedule_interval_hours END,
       active = COALESCE($13, active)
     WHERE id = $14
     RETURNING *`,
    [
      d.name ?? null, d.cidr_ranges ?? null, d.snmp_version ?? null, d.snmp_community ?? null,
      d.snmp_v3?.username ?? null, d.snmp_v3?.level ?? null, d.snmp_v3?.authProtocol ?? null, authKeyEncrypted,
      d.snmp_v3?.privProtocol ?? null, privKeyEncrypted,
      scheduleWasSent, d.schedule_interval_hours ?? null,
      d.active ?? null, id
    ]
  );
  return serializeDiscoveryRule(result.rows[0]);
});

app.delete("/api/v1/discovery-rules/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM discovery_rules WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});

// Bir kuralı npm-service'te çalıştırır -- v3 anahtarlarını burada (core'da,
// CREDENTIAL_ENCRYPTION_KEY'e sahip tek servis) çözüp npm-service'e SADECE
// internal secret ile korunan endpoint üzerinden, server-to-server iletir
// (tarayıcı asla çözülmüş anahtarı görmez). Hem manuel "Şimdi çalıştır" hem
// zamanlayıcı BU fonksiyonu paylaşır.
async function runDiscoveryRule(rule: any): Promise<{ jobId: string } | { error: string }> {
  const credentials =
    rule.snmp_version === "v3"
      ? {
          version: "v3",
          v3: {
            username: rule.snmp_v3_username,
            level: rule.snmp_v3_level,
            authProtocol: rule.snmp_v3_auth_protocol || undefined,
            authKey: rule.snmp_v3_auth_key_encrypted ? decryptSecret(rule.snmp_v3_auth_key_encrypted) : undefined,
            privProtocol: rule.snmp_v3_priv_protocol || undefined,
            privKey: rule.snmp_v3_priv_key_encrypted ? decryptSecret(rule.snmp_v3_priv_key_encrypted) : undefined
          }
        }
      : { version: "v2c", community: rule.snmp_community || "public" };

  try {
    const response = await fetch(`${NPM_SERVICE_URL}/api/v1/discovery/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET || "" },
      body: JSON.stringify({ cidrs: rule.cidr_ranges, credentials, tenantId: rule.tenant_id, ruleId: rule.id })
    });
    if (!response.ok) {
      const body: any = await response.json().catch(() => ({}));
      return { error: body.error ? JSON.stringify(body.error) : `npm-service HTTP ${response.status}` };
    }
    const body: any = await response.json();
    await pool.query(`UPDATE discovery_rules SET last_run_at = now() WHERE id = $1`, [rule.id]);
    return { jobId: body.jobId };
  } catch (err) {
    return { error: "npm-service'e ulaşılamadı" };
  }
}

app.post("/api/v1/discovery-rules/:id/run", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const ruleResult = await pool.query(`SELECT * FROM discovery_rules WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  if (ruleResult.rows.length === 0) return reply.status(404).send({ error: "Kural bulunamadı" });

  const result = await runDiscoveryRule(ruleResult.rows[0]);
  if ("error" in result) return reply.status(502).send({ error: result.error });
  return reply.status(202).send(result);
});

// NOT: tarama ilerlemesi (job status) için ayrı bir core proxy'si YOK --
// gateway zaten /api/v1/discovery/* prefix'ini npm-service'e proxy'liyor,
// frontend job durumunu GET /api/v1/discovery/scan/:jobId ile DOĞRUDAN oradan
// okuyor (job state'i hiç kimlik bilgisi taşımıyor, jobId zaten tahmin edilemez
// bir UUID -- bkz. npm-service/src/index.ts).

app.get("/api/v1/discovery-candidates", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "devices", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  // NOT EXISTS filtresi: added_device_id sadece BU sayfadan "bulk-add" ile
  // eklenmiş adayları işaretler -- bir IP başka bir yoldan (örn. Cihaz Ekle
  // formundan elle) zaten cihaz olarak kayıtlı olabilir (canlı testte bulundu:
  // snmp-simulator zaten bir cihazdı, bulk-add doğru şekilde 409/unique-hatası
  // verdi ama aday listede "yeni" gibi görünmeye devam ediyordu).
  const result = await pool.query(
    `SELECT c.id, c.ip_address, c.sys_descr, c.interface_count, c.first_seen_at, c.last_seen_at, c.rule_id,
            r.name as rule_name, r.snmp_version
     FROM discovery_candidates c
     LEFT JOIN discovery_rules r ON r.id = c.rule_id
     WHERE c.tenant_id = $1 AND c.dismissed = false AND c.added_device_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.tenant_id = c.tenant_id AND host(d.ip_address) = c.ip_address)
     ORDER BY c.last_seen_at DESC`,
    [auth.tenantId]
  );
  return result.rows;
});

app.post("/api/v1/discovery-candidates/:id/dismiss", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`UPDATE discovery_candidates SET dismissed = true WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});

const BulkAddCandidatesSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
  device_type: z.string().default("other")
});
app.post("/api/v1/discovery-candidates/bulk-add", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const parsed = BulkAddCandidatesSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const candidates = await pool.query(
    `SELECT c.*, r.snmp_version, r.snmp_community
     FROM discovery_candidates c LEFT JOIN discovery_rules r ON r.id = c.rule_id
     WHERE c.tenant_id = $1 AND c.id = ANY($2::uuid[]) AND c.added_device_id IS NULL`,
    [auth.tenantId, parsed.data.ids]
  );

  const created: any[] = [];
  const failed: { ip_address: string; error: string }[] = [];

  for (const candidate of candidates.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const deviceName = candidate.sys_descr ? String(candidate.sys_descr).slice(0, 60) : candidate.ip_address;
      const deviceResult = await client.query(
        `INSERT INTO devices (tenant_id, name, ip_address, device_type, attributes, tags)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, '[]'::jsonb)
         RETURNING id, name, ip_address`,
        [auth.tenantId, deviceName, candidate.ip_address, parsed.data.device_type]
      );
      const deviceId = deviceResult.rows[0].id;

      // Bilinen sınırlama: platform şu an sürekli SNMP izleme için SADECE v2c
      // community destekliyor (device_interfaces.snmp_community) -- v3 sadece
      // keşif anlık kontrolünde kullanılıyor. v2c bir kuralla bulunmuşsa interface
      // hemen eklenir; v3 ise kullanıcı cihazı sonradan elle yapılandırmalı.
      if (candidate.snmp_version === "v2c") {
        await client.query(
          `INSERT INTO device_interfaces (device_id, interface_type, ip_address, snmp_community) VALUES ($1, 'snmp', $2, $3)`,
          [deviceId, candidate.ip_address, candidate.snmp_community || "public"]
        );
      }

      await client.query(`UPDATE discovery_candidates SET added_device_id = $1 WHERE id = $2`, [deviceId, candidate.id]);
      await client.query("COMMIT");
      created.push(deviceResult.rows[0]);
    } catch (err: any) {
      await client.query("ROLLBACK");
      failed.push({ ip_address: candidate.ip_address, error: err.code === "23505" ? "Bu IP/isim zaten kayıtlı" : err.message });
    } finally {
      client.release();
    }
  }

  return { created, failed };
});

// npm-service'in tarama tamamlanınca çağırdığı internal endpoint -- bulunan
// host'ları kalıcı discovery_candidates'a yazar (dedup: tenant+ip). Zaten bir
// cihaza dönüştürülmüş bir aday (added_device_id dolu) ÜZERİNE YAZILMAZ.
const DiscoveryCandidatesIngestSchema = z.object({
  tenant_id: z.string().uuid(),
  rule_id: z.string().uuid(),
  found: z.array(
    z.object({
      ip: z.string(),
      reachable: z.boolean(),
      sysDescr: z.string().optional(),
      interfaceCount: z.number().optional()
    })
  )
});
app.post("/api/v1/internal/discovery/candidates", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });
  const parsed = DiscoveryCandidatesIngestSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { tenant_id, rule_id, found } = parsed.data;

  for (const item of found) {
    await pool.query(
      `INSERT INTO discovery_candidates (tenant_id, rule_id, ip_address, sys_descr, interface_count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, ip_address) DO UPDATE SET
         rule_id = $2, sys_descr = $4, interface_count = $5, last_seen_at = now(), dismissed = false
       WHERE discovery_candidates.added_device_id IS NULL`,
      [tenant_id, rule_id, item.ip, item.sysDescr || null, item.interfaceCount ?? null]
    );
  }
  return { ingested: found.length };
});

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
            COUNT(m.device_id)::int as member_count,
            (g.vmware_source_device_id IS NOT NULL) as is_vmware_managed
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

  // KULLANICI GERİ BİLDİRİMİYLE EKLENDİ: vmware-collector'ın otomatik senkronize
  // ettiği gruplar (vmware_source_device_id dolu) silinirse, o gruba bağlı
  // izin atamaları KAYBOLUR (sonraki senkronizasyon YENİ bir ID ile grubu tekrar
  // oluşturur, eski izinler kopmuş olur) -- bu yüzden elle silme ENGELLENİYOR.
  // Grup, sadece kaynak vCenter/ESXi cihazı silindiğinde CASCADE ile otomatik gider.
  const check = await pool.query(`SELECT vmware_source_device_id FROM device_groups WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  if (check.rows.length > 0 && check.rows[0].vmware_source_device_id) {
    return reply.status(403).send({ error: "Bu grup VMware tarafından otomatik yönetiliyor, elle silinemez. Kaynak vCenter/ESXi cihazı silindiğinde otomatik kaldırılır." });
  }

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
    severity: z.enum(["info", "warning", "average", "high", "disaster", "critical"]).default("warning"),
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
            pt.name as parent_template_name, t.is_protected,
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
            pt.name as parent_template_name, t.is_protected
     FROM alert_templates t
     LEFT JOIN alert_templates pt ON pt.id = t.parent_template_id
     WHERE t.tenant_id = $1 AND t.id = $2`,
    [auth.tenantId, id]
  );
  if (templateResult.rows.length === 0) return reply.status(404).send({ error: "Şablon bulunamadı" });

  const rulesResult = await pool.query(
    `SELECT r.id, r.metric_name, r.condition, r.threshold, r.duration_seconds, r.severity,
            r.depends_on_template_rule_id, dr.metric_name as depends_on_metric_name,
            r.recovery_threshold, r.tags, r.expression_ast, r.display_expression, r.instance_tag_key,
            r.escalation_policy_id, ep.name as escalation_policy_name
     FROM alert_template_rules r
     LEFT JOIN alert_template_rules dr ON dr.id = r.depends_on_template_rule_id
     LEFT JOIN escalation_policies ep ON ep.id = r.escalation_policy_id
     WHERE r.template_id = $1 ORDER BY r.metric_name`,
    [id]
  );

  const childrenResult = await pool.query(
    `SELECT id, name FROM alert_templates WHERE parent_template_id = $1`,
    [id]
  );

  return { ...templateResult.rows[0], rules: rulesResult.rows, children: childrenResult.rows };
});

// Şablon kütüphanesi v2: taşınabilir JSON export/import -- kullanıcı kendi
// şablonlarını yedekleyebilir/paylaşabilir, farklı bir kurulum/tenant'a
// aktarabilir. Ham UUID'ler (tenant_id, template_id, item id'leri) taşınmaz --
// item/kural iç referansları (master_item_id, depends_on_template_rule_id)
// dizideki İNDEKSE çevrilir, value_map ise ID yerine İSİMLE taşınır (hedef
// tenant'ta aynı isimde bir value map varsa eşleşir, yoksa boş bırakılır).
app.get("/api/v1/alert-templates/:id/export", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };

  const templateResult = await pool.query(
    `SELECT name, device_type, tags FROM alert_templates WHERE id = $1 AND tenant_id = $2`,
    [id, auth.tenantId]
  );
  if (templateResult.rows.length === 0) return reply.status(404).send({ error: "Şablon bulunamadı" });

  const itemsResult = await pool.query(
    `SELECT ti.id, ti.metric_name, ti.oid, ti.data_type, ti.unit, ti.polling_interval_seconds, ti.is_table, ti.formula, ti.formula_oids,
            ti.collector_type, ti.connection_config, ti.master_item_id, ti.tags, ti.discovery_filter_regex, ti.item_group, vm.name as value_map_name
     FROM template_items ti LEFT JOIN value_maps vm ON vm.id = ti.value_map_id
     WHERE ti.template_id = $1 ORDER BY ti.metric_name`,
    [id]
  );
  const itemIndexById = new Map(itemsResult.rows.map((item, i) => [item.id, i]));
  const items = itemsResult.rows.map((item) => ({
    metric_name: item.metric_name, oid: item.oid, data_type: item.data_type, unit: item.unit,
    polling_interval_seconds: item.polling_interval_seconds, is_table: item.is_table, formula: item.formula,
    formula_oids: item.formula_oids, collector_type: item.collector_type, connection_config: item.connection_config,
    tags: item.tags, discovery_filter_regex: item.discovery_filter_regex, item_group: item.item_group,
    value_map_name: item.value_map_name,
    master_item_index: item.master_item_id ? (itemIndexById.get(item.master_item_id) ?? null) : null
  }));

  const rulesResult = await pool.query(
    `SELECT id, metric_name, condition, threshold, duration_seconds, severity, threshold_macro_key, tags,
            recovery_threshold, expression_ast, display_expression, instance_tag_key, depends_on_template_rule_id
     FROM alert_template_rules WHERE template_id = $1 ORDER BY metric_name`,
    [id]
  );
  const ruleIndexById = new Map(rulesResult.rows.map((rule, i) => [rule.id, i]));
  // GERÇEK HATA DÜZELTMESİ (canlı HTTP testinde bulundu): threshold/recovery_threshold
  // Postgres'te NUMERIC tipinde -- node-pg bunu STRING olarak döndürür ("10", "90.5"
  // gibi). Export JSON'ında Number()'a çevrilmezse, import şeması (z.number()) bunu
  // reddediyordu -- export edip aynı sistemde geri import etmek bile başarısız oluyordu.
  const rules = rulesResult.rows.map((rule) => ({
    metric_name: rule.metric_name, condition: rule.condition,
    threshold: rule.threshold !== null ? Number(rule.threshold) : null,
    duration_seconds: rule.duration_seconds,
    severity: rule.severity, threshold_macro_key: rule.threshold_macro_key, tags: rule.tags,
    recovery_threshold: rule.recovery_threshold !== null ? Number(rule.recovery_threshold) : null,
    expression_ast: rule.expression_ast, display_expression: rule.display_expression, instance_tag_key: rule.instance_tag_key,
    depends_on_index: rule.depends_on_template_rule_id ? (ruleIndexById.get(rule.depends_on_template_rule_id) ?? null) : null
  }));

  const scenariosResult = await pool.query(
    `SELECT id, name, user_agent, polling_interval_seconds FROM web_scenarios WHERE template_id = $1`,
    [id]
  );
  const webScenarios = [];
  for (const scenario of scenariosResult.rows) {
    const stepsResult = await pool.query(
      `SELECT step_order, name, url, expected_status_code FROM web_scenario_steps WHERE scenario_id = $1 ORDER BY step_order`,
      [scenario.id]
    );
    webScenarios.push({ name: scenario.name, user_agent: scenario.user_agent, polling_interval_seconds: scenario.polling_interval_seconds, steps: stepsResult.rows });
  }

  reply.header("Content-Disposition", `attachment; filename="${templateResult.rows[0].name.replace(/[^a-zA-Z0-9._-]/g, "_")}.json"`);
  return {
    export_format_version: 1,
    template: templateResult.rows[0],
    items,
    rules,
    web_scenarios: webScenarios
  };
});

const ImportItemSchema = z.object({
  metric_name: z.string(), oid: z.string().nullable().optional(), data_type: z.string(), unit: z.string().nullable().optional(),
  polling_interval_seconds: z.number(), is_table: z.boolean(), formula: z.string().nullable().optional(),
  formula_oids: z.record(z.string()).nullable().optional(), collector_type: z.string(), connection_config: z.record(z.any()),
  tags: z.array(z.object({ tag: z.string(), value: z.string() })).optional(), discovery_filter_regex: z.string().nullable().optional(),
  item_group: z.string().nullable().optional(), value_map_name: z.string().nullable().optional(), master_item_index: z.number().nullable().optional()
});
const ImportRuleSchema = z.object({
  metric_name: z.string().nullable().optional(), condition: z.string().nullable().optional(), threshold: z.number().nullable().optional(),
  duration_seconds: z.number(), severity: z.string(), threshold_macro_key: z.string().nullable().optional(),
  tags: z.array(z.object({ tag: z.string(), value: z.string() })).optional(), recovery_threshold: z.number().nullable().optional(),
  expression_ast: z.record(z.any()).nullable().optional(), display_expression: z.string().nullable().optional(),
  instance_tag_key: z.enum(["interface", "instance_label"]).nullable().optional(), depends_on_index: z.number().nullable().optional()
});
const ImportTemplateSchema = z.object({
  name: z.string().min(1),
  template: z.object({ name: z.string(), device_type: z.string().nullable().optional(), tags: z.array(z.string()).optional() }),
  items: z.array(ImportItemSchema).default([]),
  rules: z.array(ImportRuleSchema).default([]),
  web_scenarios: z.array(z.object({
    name: z.string(), user_agent: z.string().nullable().optional(), polling_interval_seconds: z.number(),
    steps: z.array(z.object({ step_order: z.number(), name: z.string(), url: z.string(), expected_status_code: z.number() }))
  })).default([])
});

app.post("/api/v1/alert-templates/import", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const parsed = ImportTemplateSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { name, items, rules, web_scenarios } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const newTemplate = await client.query(
      `INSERT INTO alert_templates (tenant_id, name, device_type, tags, is_protected) VALUES ($1, $2, $3, $4, false) RETURNING id, name`,
      [auth.tenantId, name, parsed.data.template.device_type || null, JSON.stringify(parsed.data.template.tags || [])]
    );
    const newTemplateId = newTemplate.rows[0].id;

    let unmatchedValueMaps = 0;
    const newItemIds: string[] = [];
    for (const item of items) {
      let valueMapId: string | null = null;
      if (item.value_map_name) {
        const vm = await client.query(`SELECT id FROM value_maps WHERE tenant_id = $1 AND name = $2`, [auth.tenantId, item.value_map_name]);
        if (vm.rows.length > 0) valueMapId = vm.rows[0].id;
        else unmatchedValueMaps++;
      }
      const inserted = await client.query(
        `INSERT INTO template_items (template_id, metric_name, oid, data_type, unit, polling_interval_seconds, is_table, formula, formula_oids, collector_type, connection_config, tags, discovery_filter_regex, item_group, value_map_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
        [newTemplateId, item.metric_name, item.oid || null, item.data_type, item.unit || null, item.polling_interval_seconds, item.is_table,
         item.formula || null, item.formula_oids ? JSON.stringify(item.formula_oids) : null, item.collector_type, JSON.stringify(item.connection_config),
         JSON.stringify(item.tags || []), item.discovery_filter_regex || null, item.item_group || null, valueMapId]
      );
      newItemIds.push(inserted.rows[0].id);
    }
    for (let i = 0; i < items.length; i++) {
      const masterIdx = items[i].master_item_index;
      if (masterIdx !== null && masterIdx !== undefined && newItemIds[masterIdx]) {
        await client.query(`UPDATE template_items SET master_item_id = $1 WHERE id = $2`, [newItemIds[masterIdx], newItemIds[i]]);
      }
    }

    const newRuleIds: string[] = [];
    for (const rule of rules) {
      const inserted = await client.query(
        `INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity, threshold_macro_key, tags, recovery_threshold, expression_ast, display_expression, instance_tag_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [newTemplateId, rule.metric_name || null, rule.condition || null, rule.threshold ?? null, rule.duration_seconds, rule.severity,
         rule.threshold_macro_key || null, JSON.stringify(rule.tags || []), rule.recovery_threshold ?? null,
         rule.expression_ast ? JSON.stringify(rule.expression_ast) : null, rule.display_expression || null, rule.instance_tag_key || null]
      );
      newRuleIds.push(inserted.rows[0].id);
    }
    for (let i = 0; i < rules.length; i++) {
      const depIdx = rules[i].depends_on_index;
      if (depIdx !== null && depIdx !== undefined && newRuleIds[depIdx]) {
        await client.query(`UPDATE alert_template_rules SET depends_on_template_rule_id = $1 WHERE id = $2`, [newRuleIds[depIdx], newRuleIds[i]]);
      }
    }

    for (const scenario of web_scenarios) {
      const newScenario = await client.query(
        `INSERT INTO web_scenarios (template_id, name, user_agent, polling_interval_seconds) VALUES ($1, $2, $3, $4) RETURNING id`,
        [newTemplateId, scenario.name, scenario.user_agent || null, scenario.polling_interval_seconds]
      );
      for (const step of scenario.steps) {
        await client.query(
          `INSERT INTO web_scenario_steps (scenario_id, step_order, name, url, expected_status_code) VALUES ($1, $2, $3, $4, $5)`,
          [newScenario.rows[0].id, step.step_order, step.name, step.url, step.expected_status_code]
        );
      }
    }

    await client.query("COMMIT");
    return reply.status(201).send({ id: newTemplateId, name: newTemplate.rows[0].name, unmatched_value_maps: unmatchedValueMaps });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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
  // GÜVENLİK DÜZELTMESİ: bu endpoint'te hiç yetki kontrolü yoktu -- read-only bir
  // kullanıcı bile herhangi bir şablonu (ve CASCADE ile tüm item/kural/atamalarını)
  // kalıcı olarak silebiliyordu.
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  if (await templateIsProtected(id)) return reply.status(403).send(PROTECTED_TEMPLATE_ERROR);
  await pool.query(`DELETE FROM alert_templates WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});

// Şablon kütüphanesi v2: bir şablonu (item'ları + kuralları + web senaryolarıyla
// birlikte) yeni bir isimle kopyalar. Kök neden: klonlama olmayınca kullanıcılar
// Cisco şablonlarını elle kopyalayıp 9 parçalı bir dağınıklık yaratmıştı -- artık
// "temel" (korumalı) bir şablonu değiştirmek isteyen biri önce klonlayıp kendi
// kopyasında düzenleyebilir. Klonlar HER ZAMAN is_protected=false başlar.
const CloneTemplateSchema = z.object({ name: z.string().min(1) });

app.post("/api/v1/alert-templates/:id/clone", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const parsed = CloneTemplateSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const source = await pool.query(
    `SELECT id, device_type, tags FROM alert_templates WHERE id = $1 AND tenant_id = $2`,
    [id, auth.tenantId]
  );
  if (source.rows.length === 0) return reply.status(404).send({ error: "Şablon bulunamadı" });
  const src = source.rows[0];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const newTemplate = await client.query(
      `INSERT INTO alert_templates (tenant_id, name, device_type, tags, is_protected)
       VALUES ($1, $2, $3, $4, false) RETURNING id, name`,
      [auth.tenantId, parsed.data.name, src.device_type, src.tags]
    );
    const newTemplateId = newTemplate.rows[0].id;

    // Item'lar -- master_item_id (aynı şablon içi kendine referans) İKİ AŞAMADA
    // çözülüyor: önce hepsi master_item_id=NULL ile eklenir (eski id -> yeni id
    // haritası çıkarılır), sonra ikinci bir UPDATE ile gerçek master_item_id'ler
    // yeni id'lere çevrilir.
    const items = await client.query(
      `SELECT id, metric_name, oid, data_type, unit, polling_interval_seconds, is_table, formula, formula_oids,
              collector_type, connection_config, master_item_id, tags, discovery_filter_regex, value_map_id, item_group
       FROM template_items WHERE template_id = $1`,
      [id]
    );
    const itemIdMap = new Map<string, string>();
    for (const item of items.rows) {
      const inserted = await client.query(
        `INSERT INTO template_items (template_id, metric_name, oid, data_type, unit, polling_interval_seconds, is_table, formula, formula_oids, collector_type, connection_config, tags, discovery_filter_regex, value_map_id, item_group)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
        [newTemplateId, item.metric_name, item.oid, item.data_type, item.unit, item.polling_interval_seconds, item.is_table, item.formula, item.formula_oids, item.collector_type, item.connection_config, item.tags, item.discovery_filter_regex, item.value_map_id, item.item_group]
      );
      itemIdMap.set(item.id, inserted.rows[0].id);
    }
    for (const item of items.rows) {
      if (item.master_item_id && itemIdMap.has(item.master_item_id)) {
        await client.query(`UPDATE template_items SET master_item_id = $1 WHERE id = $2`, [itemIdMap.get(item.master_item_id), itemIdMap.get(item.id)]);
      }
    }

    // Item preprocessing adımları eski->yeni item haritasıyla kopyalanır.
    const preSteps = await client.query(
      `SELECT template_item_id, step_order, step_type, params FROM item_preprocessing_steps WHERE template_item_id = ANY($1::uuid[])`,
      [items.rows.map((i) => i.id)]
    );
    for (const step of preSteps.rows) {
      const newItemId = itemIdMap.get(step.template_item_id);
      if (!newItemId) continue;
      await client.query(
        `INSERT INTO item_preprocessing_steps (template_item_id, step_order, step_type, params) VALUES ($1, $2, $3, $4)`,
        [newItemId, step.step_order, step.step_type, step.params]
      );
    }

    // Kurallar -- depends_on_template_rule_id aynı iki-aşamalı desenle çözülür.
    const rules = await client.query(
      `SELECT id, metric_name, condition, threshold, duration_seconds, severity, depends_on_template_rule_id,
              threshold_macro_key, tags, recovery_threshold, expression_ast, display_expression, instance_tag_key
       FROM alert_template_rules WHERE template_id = $1`,
      [id]
    );
    const ruleIdMap = new Map<string, string>();
    for (const rule of rules.rows) {
      const inserted = await client.query(
        `INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity, threshold_macro_key, tags, recovery_threshold, expression_ast, display_expression, instance_tag_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [newTemplateId, rule.metric_name, rule.condition, rule.threshold, rule.duration_seconds, rule.severity, rule.threshold_macro_key, rule.tags, rule.recovery_threshold, rule.expression_ast, rule.display_expression, rule.instance_tag_key]
      );
      ruleIdMap.set(rule.id, inserted.rows[0].id);
    }
    for (const rule of rules.rows) {
      if (rule.depends_on_template_rule_id && ruleIdMap.has(rule.depends_on_template_rule_id)) {
        await client.query(`UPDATE alert_template_rules SET depends_on_template_rule_id = $1 WHERE id = $2`, [ruleIdMap.get(rule.depends_on_template_rule_id), ruleIdMap.get(rule.id)]);
      }
    }

    // Web senaryoları + adımları.
    const scenarios = await client.query(
      `SELECT id, name, user_agent, polling_interval_seconds FROM web_scenarios WHERE template_id = $1`,
      [id]
    );
    for (const scenario of scenarios.rows) {
      const newScenario = await client.query(
        `INSERT INTO web_scenarios (template_id, name, user_agent, polling_interval_seconds) VALUES ($1, $2, $3, $4) RETURNING id`,
        [newTemplateId, scenario.name, scenario.user_agent, scenario.polling_interval_seconds]
      );
      const steps = await client.query(
        `SELECT step_order, name, url, expected_status_code FROM web_scenario_steps WHERE scenario_id = $1 ORDER BY step_order`,
        [scenario.id]
      );
      for (const step of steps.rows) {
        await client.query(
          `INSERT INTO web_scenario_steps (scenario_id, step_order, name, url, expected_status_code) VALUES ($1, $2, $3, $4, $5)`,
          [newScenario.rows[0].id, step.step_order, step.name, step.url, step.expected_status_code]
        );
      }
    }

    await client.query("COMMIT");
    return reply.status(201).send({ id: newTemplateId, name: newTemplate.rows[0].name });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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
        `INSERT INTO alert_rules (tenant_id, source_module, metric_name, condition, threshold, duration_seconds, device_id, severity, template_rule_id, expression_ast, display_expression, instance_tag_key, escalation_policy_id)
         VALUES ($1, 'npm', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (device_id, template_rule_id) WHERE template_rule_id IS NOT NULL
         DO UPDATE SET condition = EXCLUDED.condition, threshold = EXCLUDED.threshold,
                        duration_seconds = EXCLUDED.duration_seconds, severity = EXCLUDED.severity,
                        expression_ast = EXCLUDED.expression_ast, display_expression = EXCLUDED.display_expression,
                        instance_tag_key = EXCLUDED.instance_tag_key, escalation_policy_id = EXCLUDED.escalation_policy_id
         RETURNING id`,
        [tenantId, rule.metric_name, rule.condition, effectiveThreshold, rule.duration_seconds, deviceId, rule.severity, rule.id,
         resolvedExpressionAst ? JSON.stringify(resolvedExpressionAst) : null, rule.display_expression || null, rule.instance_tag_key || null, rule.escalation_policy_id || null]
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
    `SELECT id, metric_name, condition, threshold, duration_seconds, severity, depends_on_template_rule_id, threshold_macro_key, expression_ast, display_expression, instance_tag_key, escalation_policy_id
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
  // GERÇEK HATA DÜZELTMESİ (kullanıcı yönetimi denetiminde bulundu): burada
  // "read_write" isteniyordu -- diğer tüm liste endpoint'leriyle tutarsız
  // (örn. GET /user-groups sadece "read" ister). "users: read" (salt-görüntüleme)
  // izni olan bir rol kullanıcı listesini bile göremiyordu.
  if (!hasPermission(auth, "users", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const result = await pool.query(
    `SELECT u.id, u.email, u.created_at, u.enabled, r.id as role_id, r.name as role_name
     FROM users u
     LEFT JOIN user_roles r ON r.id = u.role_id
     WHERE u.tenant_id = $1
     ORDER BY u.created_at`,
    [auth.tenantId]
  );
  return result.rows;
});


const PermissionLevelSchema = z.enum(["none", "read", "read_write"]);
const CreateRoleSchema = z.object({
  name: z.string().min(1),
  permissions: z.record(PermissionLevelSchema).default({})
});

// Yardımcı: role_id için user_role_permissions satırlarını (INSERT ... ON CONFLICT
// DO UPDATE ile) yazar. Bilinmeyen kaynak adları sessizce yok sayılır (yazım hatası
// yüzünden geçersiz bir kaynağın DB'ye yazılmasını engellemek için).
async function upsertRolePermissions(client: any, roleId: string, permissions: Record<string, string>) {
  for (const [resource, level] of Object.entries(permissions)) {
    if (!ALL_RESOURCES.includes(resource)) continue;
    await client.query(
      `INSERT INTO user_role_permissions (role_id, resource, level) VALUES ($1, $2, $3)
       ON CONFLICT (role_id, resource) DO UPDATE SET level = $3`,
      [roleId, resource, level]
    );
  }
}

app.post("/api/v1/user-roles", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "users", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const parsed = CreateRoleSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { name, permissions } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO user_roles (tenant_id, name) VALUES ($1, $2) RETURNING id, name`,
      [auth.tenantId, name]
    );
    const roleId = result.rows[0].id;
    await upsertRolePermissions(client, roleId, permissions);
    await client.query("COMMIT");
    return reply.status(201).send({ ...result.rows[0], permissions: await resolvePermissionsForRole(roleId) });
  } catch (err: any) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return reply.status(409).send({ error: "Bu isimde bir rol zaten var" });
    throw err;
  } finally {
    client.release();
  }
});

const UpdateRoleSchema = z.object({
  name: z.string().min(1).optional(),
  permissions: z.record(PermissionLevelSchema).optional()
});

app.patch("/api/v1/user-roles/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "users", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("user_roles", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Rol bulunamadı" });
  }
  const parsed = UpdateRoleSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { name, permissions } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (name) {
      await client.query(`UPDATE user_roles SET name = $2 WHERE id = $1`, [id, name]);
    }
    if (permissions) {
      await upsertRolePermissions(client, id, permissions);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  const roleResult = await pool.query(`SELECT id, name FROM user_roles WHERE id = $1`, [id]);
  return { ...roleResult.rows[0], permissions: await resolvePermissionsForRole(id) };
});

app.delete("/api/v1/user-roles/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "users", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("user_roles", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Rol bulunamadı" });
  }

  const usersWithRole = await pool.query(`SELECT COUNT(*)::int as count FROM users WHERE role_id = $1`, [id]);
  if (usersWithRole.rows[0].count > 0) {
    return reply.status(409).send({ error: "Bu role atanmış kullanıcılar var, önce onları başka bir role taşıyın" });
  }

  await pool.query(`DELETE FROM user_roles WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});

app.get("/api/v1/user-roles", async (request, reply) => {
  const auth = (request as any).auth;
  // GÜVENLİK DÜZELTMESİ (kullanıcı yönetimi denetiminde bulundu): hiç izin
  // kontrolü yoktu -- herhangi bir kullanıcı (users izni "none" olsa bile) her
  // rolün TAM izin matrisini görebiliyordu.
  if (!hasPermission(auth, "users", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const result = await pool.query(
    `SELECT id, name FROM user_roles WHERE tenant_id = $1 ORDER BY name`,
    [auth.tenantId]
  );
  // N+1 sorgu gibi görünse de rol sayısı tipik olarak küçük (onlarca değil, birkaç
  // düzine); performans sorun olursa tek sorguda JOIN+array_agg'e çevrilebilir.
  const roles = [];
  for (const role of result.rows) {
    roles.push({ ...role, permissions: await resolvePermissionsForRole(role.id) });
  }
  return roles;
});

const CreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role_id: z.string().uuid(),
  // GERÇEK EKSİKLİK DÜZELTMESİ (kullanıcı yönetimi denetiminde bulundu): yeni
  // bir kullanıcı hiçbir gruba eklenmiyordu -- resolveDeviceGroupAccess grupsuz
  // kullanıcı için "kısıtlama yok" (tüm cihazlar görünür) döndürdüğünden, bu
  // varsayılan olarak devices izni olan her yeni kullanıcının TÜM tenant
  // cihazlarını görmesi anlamına geliyordu. Artık oluşturma anında opsiyonel
  // bir gruba eklenebiliyor.
  group_id: z.string().uuid().optional()
});

app.post("/api/v1/users", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "users", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const parsed = CreateUserSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { email, password, role_id, group_id } = parsed.data;

  // GÜVENLİK: role_id'nin çağıranın tenant'ına ait olduğu doğrulanmıyordu --
  // başka bir tenant'ın rol id'si verilirse o kullanıcı o rolün (başka tenant'a
  // ait) izinleriyle oluşturulabilirdi.
  if (!(await idBelongsToTenant("user_roles", role_id, auth.tenantId))) {
    return reply.status(400).send({ error: "Geçersiz rol" });
  }
  if (group_id && !(await idBelongsToTenant("user_groups", group_id, auth.tenantId))) {
    return reply.status(400).send({ error: "Geçersiz kullanıcı grubu" });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, role_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, created_at`,
      [auth.tenantId, email, passwordHash, role_id]
    );
    if (group_id) {
      await pool.query(
        `INSERT INTO user_group_members (user_group_id, user_id) VALUES ($1, $2)`,
        [group_id, result.rows[0].id]
      );
    }
    return reply.status(201).send(result.rows[0]);
  } catch (err: any) {
    if (err.code === "23505") return reply.status(409).send({ error: "Bu email zaten kayıtlı" });
    throw err;
  }
});

const UpdateUserSchema = z.object({
  email: z.string().email().optional(),
  role_id: z.string().uuid().optional(),
  enabled: z.boolean().optional()
});

// GERÇEK EKSİKLİK DÜZELTMESİ (kullanıcı yönetimi denetiminde bulundu): bir
// kullanıcının email/rol/aktiflik durumunu oluşturduktan sonra değiştirmenin
// HİÇBİR yolu yoktu (ne PATCH endpoint'i ne frontend butonu).
app.patch("/api/v1/users/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "users", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const parsed = UpdateUserSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { email, role_id, enabled } = parsed.data;

  if (!(await idBelongsToTenant("users", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Kullanıcı bulunamadı" });
  }
  if (role_id && !(await idBelongsToTenant("user_roles", role_id, auth.tenantId))) {
    return reply.status(400).send({ error: "Geçersiz rol" });
  }
  // Kullanıcı kendi hesabını yanlışlıkla devre dışı bırakıp kilitlenmesin diye.
  if (id === auth.userId && enabled === false) {
    return reply.status(400).send({ error: "Kendi hesabınızı devre dışı bırakamazsınız" });
  }

  try {
    const result = await pool.query(
      `UPDATE users SET
         email = COALESCE($3, email),
         role_id = COALESCE($4, role_id),
         enabled = COALESCE($5, enabled)
       WHERE tenant_id = $1 AND id = $2
       RETURNING id, email, created_at, enabled, role_id`,
      [auth.tenantId, id, email, role_id, enabled]
    );
    return result.rows[0];
  } catch (err: any) {
    if (err.code === "23505") return reply.status(409).send({ error: "Bu email zaten kayıtlı" });
    throw err;
  }
});

app.delete("/api/v1/users/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "users", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  if (id === auth.userId) return reply.status(400).send({ error: "Kendi hesabınızı silemezsiniz" });
  await pool.query(`DELETE FROM users WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});

// GERÇEK EKSİKLİK DÜZELTMESİ (kullanıcı yönetimi denetiminde bulundu): şifre
// sıfırlama/değiştirme akışı HİÇ yoktu -- bir kullanıcı şifresini unutursa veya
// değiştirmek isterse hiçbir yol yoktu. İki ayrı endpoint: admin başka bir
// kullanıcının şifresini sıfırlar (mevcut şifreyi bilmeden), kullanıcı kendi
// şifresini değiştirir (mevcut şifreyi doğrulayarak).
const AdminResetPasswordSchema = z.object({ password: z.string().min(8) });

app.patch("/api/v1/users/:id/password", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "users", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const parsed = AdminResetPasswordSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  if (!(await idBelongsToTenant("users", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Kullanıcı bulunamadı" });
  }
  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  await pool.query(`UPDATE users SET password_hash = $3 WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id, passwordHash]);
  return reply.status(204).send();
});

const ChangeOwnPasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8)
});

// Kasıtlı olarak "users" kaynağına bağlı bir izin kontrolü YOK -- bu kendi
// hesabınla ilgili bir işlem, rolünün "users" iznine bakılmaksızın her
// kimliği doğrulanmış kullanıcı kendi şifresini değiştirebilmeli.
app.patch("/api/v1/users/me/password", async (request, reply) => {
  const auth = (request as any).auth;
  const parsed = ChangeOwnPasswordSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { current_password, new_password } = parsed.data;

  const result = await pool.query(`SELECT password_hash FROM users WHERE id = $1 AND tenant_id = $2`, [auth.userId, auth.tenantId]);
  if (result.rows.length === 0) return reply.status(404).send({ error: "Kullanıcı bulunamadı" });

  const validCurrent = await bcrypt.compare(current_password, result.rows[0].password_hash);
  if (!validCurrent) return reply.status(401).send({ error: "Mevcut şifre yanlış" });

  const passwordHash = await bcrypt.hash(new_password, 10);
  await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [auth.userId, passwordHash]);
  return reply.status(204).send();
});


// ============ MEDIA TYPES & NOTIFICATIONS ============

// Bildirim sistemi tasarımı (kullanıcıyla konuşulup kararlaştırıldı): email
// tipi gerçekten çalışabilmesi için SMTP alanlarını taşımalı -- önceden config
// tamamen boş ({}) gönderiliyordu, hiçbir e-posta kanalı hiç çalışamıyordu.
// smtp_pass DÜZ METİN kabul edilir ama ASLA öyle saklanmaz -- macro'lardaki
// value_type='secret' ile AYNI desen: encryptSecret ile şifrelenip
// smtp_pass_encrypted olarak saklanır, API yanıtlarında hiçbir zaman (ne düz
// ne şifreli) geri dönmez, sadece has_smtp_password boolean'ı döner.
// webhook için "format": sabit {device,severity,message,...} payload'ı Slack/
// Teams'in beklediği formatla UYUŞMUYORDU (webhook kanalı gerçekte sadece ham
// alıcılarla çalışıyordu) -- artık hedefe göre doğru şekilli payload üretiliyor.
const MediaTypeConfigSchema = z.object({
  smtp_host: z.string().optional(),
  smtp_port: z.number().int().optional(),
  smtp_secure: z.boolean().optional(),
  smtp_user: z.string().optional(),
  smtp_pass: z.string().optional(),
  from: z.string().optional(),
  format: z.enum(["generic", "slack", "teams"]).optional()
});

const CreateMediaTypeSchema = z.object({
  type: z.enum(["email", "webhook"]),
  name: z.string().min(1),
  config: MediaTypeConfigSchema.default({})
});

const UpdateMediaTypeSchema = z.object({
  name: z.string().min(1).optional(),
  active: z.boolean().optional(),
  config: MediaTypeConfigSchema.optional()
});

// smtp_pass düz metin geldiyse şifreleyip smtp_pass_encrypted'a taşır, config'te
// düz metin ASLA kalmaz. Boş/tanımsızsa dokunmaz (PATCH'te "şifreyi değiştirme" anlamına gelir).
function prepareMediaTypeConfig(config: Record<string, any>, existingConfig?: Record<string, any>): Record<string, any> {
  const merged = { ...(existingConfig ?? {}), ...config };
  const { smtp_pass, ...rest } = merged;
  if (smtp_pass) {
    rest.smtp_pass_encrypted = encryptSecret(smtp_pass);
  }
  return rest;
}

function maskMediaTypeConfig(config: Record<string, any>): Record<string, any> {
  const { smtp_pass_encrypted, ...rest } = config ?? {};
  return { ...rest, has_smtp_password: !!smtp_pass_encrypted };
}

app.get("/api/v1/media-types", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT id, type, name, config, active FROM media_types WHERE tenant_id = $1 ORDER BY name`,
    [auth.tenantId]
  );
  return result.rows.map((r) => ({ ...r, config: maskMediaTypeConfig(r.config) }));
});

app.post("/api/v1/media-types", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "users", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const parsed = CreateMediaTypeSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const storedConfig = prepareMediaTypeConfig(parsed.data.config);
  const result = await pool.query(
    `INSERT INTO media_types (tenant_id, type, name, config) VALUES ($1, $2, $3, $4)
     RETURNING id, type, name, config, active`,
    [auth.tenantId, parsed.data.type, parsed.data.name, storedConfig]
  );
  return reply.status(201).send({ ...result.rows[0], config: maskMediaTypeConfig(result.rows[0].config) });
});

app.patch("/api/v1/media-types/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "users", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const parsed = UpdateMediaTypeSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const existing = await pool.query(`SELECT config FROM media_types WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  if (existing.rows.length === 0) return reply.status(404).send({ error: "Kanal bulunamadı" });

  const newConfig = parsed.data.config ? prepareMediaTypeConfig(parsed.data.config, existing.rows[0].config) : existing.rows[0].config;
  const result = await pool.query(
    `UPDATE media_types SET
       name = COALESCE($3, name),
       active = COALESCE($4, active),
       config = $5
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, type, name, config, active`,
    [auth.tenantId, id, parsed.data.name ?? null, parsed.data.active ?? null, newConfig]
  );
  return { ...result.rows[0], config: maskMediaTypeConfig(result.rows[0].config) };
});

app.delete("/api/v1/media-types/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "users", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM media_types WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});

// Test bildirimi -- kullanıcı gerçek bir alarm oluşana kadar kanalın çalışıp
// çalışmadığını hiçbir şekilde öğrenemiyordu. Gerçek gönderim mantığı (SMTP/
// webhook) alarm-engine'de yaşıyor (nodemailer bağımlılığı orada) -- core
// burada sadece internal secret ile alarm-engine'in test endpoint'ine vekillik eder.
app.post("/api/v1/media-types/:id/test", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "users", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const { destination } = request.body as { destination?: string };
  if (!destination) return reply.status(400).send({ error: "destination (e-posta veya webhook URL'i) gerekli" });

  const mediaTypeCheck = await pool.query(`SELECT id FROM media_types WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  if (mediaTypeCheck.rows.length === 0) return reply.status(404).send({ error: "Kanal bulunamadı" });

  const ALARM_ENGINE_URL = process.env.ALARM_ENGINE_URL || "http://alarm-engine:3500";
  try {
    const response = await fetch(`${ALARM_ENGINE_URL}/internal/test-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET || "" },
      body: JSON.stringify({ mediaTypeId: id, destination })
    });
    const body = await response.json();
    return reply.status(response.status).send(body);
  } catch (err: any) {
    return reply.status(502).send({ error: `Alarm motoruna ulaşılamadı: ${err.message}` });
  }
});

const CreateUserMediaSchema = z.object({
  media_type_id: z.string().uuid(),
  destination: z.string().min(1),
  device_group_id: z.string().uuid().nullable().optional(),
  min_severity: z.enum(["info", "warning", "average", "high", "disaster", "critical"]).default("warning")
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
            ti.collector_type, ti.connection_config, ti.value_map_id, vm.name as value_map_name, ti.tags, ti.item_group
     FROM template_items ti
     LEFT JOIN value_maps vm ON vm.id = ti.value_map_id
     WHERE ti.template_id = $1 ORDER BY ti.metric_name`,
    [id]
  );
  return result.rows;
});

app.post("/api/v1/alert-templates/:id/items", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("alert_templates", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Şablon bulunamadı" });
  }
  if (await templateIsProtected(id)) return reply.status(403).send(PROTECTED_TEMPLATE_ERROR);
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
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  if (await templateItemIsProtected(id)) return reply.status(403).send(PROTECTED_TEMPLATE_ERROR);
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
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

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
    `SELECT id, metric_name, condition, threshold, duration_seconds, severity, depends_on_template_rule_id, threshold_macro_key, expression_ast, display_expression, instance_tag_key, escalation_policy_id
     FROM alert_template_rules WHERE template_id = $1`,
    [parsed.data.template_id]
  );
  let rulesApplied = 0;
  if (rulesResult.rows.length > 0) {
    rulesApplied = await applyTemplateRulesToDevices(rulesResult, [id], auth.tenantId);
  }

  return reply.status(201).send({ device_id: id, template_id: parsed.data.template_id, rulesApplied });
});

// Şablon kütüphanesi temizliği: bir şablonun opsiyonel alt-grupları (örn.
// "Windows by Zabbix agent" şablonundaki "services" grubu -- Windows servis
// izleme, artık ayrı bir şablon değil, ana şablonun isteğe bağlı bir parçası)
// bu listede available_groups/enabled_groups olarak dönüyor ki cihaz
// sayfasında aç/kapa yapılabilsin.
app.get("/api/v1/devices/:id/templates", async (request) => {
  const { id } = request.params as { id: string };
  const result = await pool.query(
    `SELECT t.id, t.name, dt.enabled_groups,
       COALESCE((SELECT array_agg(DISTINCT ti.item_group) FROM template_items ti WHERE ti.template_id = t.id AND ti.item_group IS NOT NULL), '{}') as available_groups
     FROM device_templates dt JOIN alert_templates t ON t.id = dt.template_id WHERE dt.device_id = $1`,
    [id]
  );
  return result.rows;
});

const SetTemplateGroupSchema = z.object({ group: z.string().min(1), enabled: z.boolean() });

app.patch("/api/v1/devices/:id/templates/:templateId/groups", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id, templateId } = request.params as { id: string; templateId: string };
  const parsed = SetTemplateGroupSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const result = await pool.query(
    `UPDATE device_templates SET enabled_groups =
       CASE WHEN $3 THEN array_append(array_remove(enabled_groups, $4::text), $4::text)
            ELSE array_remove(enabled_groups, $4::text) END
     WHERE device_id = $1 AND template_id = $2
     RETURNING enabled_groups`,
    [id, templateId, parsed.data.enabled, parsed.data.group]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Cihaz-şablon ataması bulunamadı" });
  return result.rows[0];
});

app.delete("/api/v1/devices/:id/templates/:templateId", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
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

  // RCA Confidence Motoru: topoloji + trafik ilişkilerini, zamansal yakınlığı
  // ve hiyerarşi merkeziyetini TEK bir 0-100 confidence skorunda birleştiren
  // paylaşılan fonksiyon (rootCause.ts) -- hem bu endpoint HEM gelecekteki
  // correlation/incident motoru tarafından çağrılır (kod tekrarını önlemek
  // için kullanıcıyla onaylanmış mimari karar).
  const { anchor_time: anchorTime, candidates: rootCauseCandidates, traffic_links_updated_at: trafficLinksUpdatedAt } =
    await computeRootCauseCandidates(pool, auth.tenantId, id);
  // likely_root_cause boolean'ı confidence eşiğinden (>60) türetiliyor.
  // relationship_weight/temporal_score/hierarchy_weight/hop_decay/path: RCA
  // incelemesinde bulunan gerçek eksiklik -- confidence'ın NEDEN o sayı olduğunu
  // döküm halinde göstermek için (bkz. IncidentDetail.tsx/DeviceDetail.tsx).
  const topologyNeighbors = rootCauseCandidates.map((c) => ({
    id: c.id,
    name: c.name,
    hop_distance: c.hop_distance,
    open_alert_message: c.open_alert_message,
    open_alert_triggered_at: c.open_alert_triggered_at,
    open_alert_severity: c.open_alert_severity,
    confidence: c.confidence,
    likely_root_cause: c.confidence > 60,
    relationship_weight: c.relationship_weight,
    temporal_score: c.temporal_score,
    hierarchy_weight: c.hierarchy_weight,
    hop_decay: c.hop_decay,
    path: c.path
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
    anchor_time: anchorTime,
    traffic_links_updated_at: trafficLinksUpdatedAt
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
            dep_rule.metric_name as depends_on_metric_name,
            r.instance_tag_key
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
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

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
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
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
app.get("/api/v1/suppressed-alerts", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const conditions = ["sa.tenant_id = $1"];
  const params: any[] = [auth.tenantId];
  const deviceGroupAccess = await resolveDeviceGroupAccess(auth.userId);
  if (Object.keys(deviceGroupAccess).length > 0) {
    const allowedGroupIds = Object.entries(deviceGroupAccess).filter(([, p]) => p !== "deny").map(([gid]) => gid);
    if (allowedGroupIds.length === 0) return [];
    conditions.push(`sa.device_id IN (SELECT device_id FROM device_group_members WHERE device_group_id = ANY($2::uuid[]))`);
    params.push(allowedGroupIds);
  }

  const result = await pool.query(
    `SELECT sa.id, sa.message, sa.suppressed_at,
            d.name as device_name, d.id as device_id,
            r.metric_name as suppressed_metric,
            dr.metric_name as suppressing_metric
     FROM suppressed_alerts sa
     JOIN devices d ON d.id = sa.device_id
     JOIN alert_rules r ON r.id = sa.rule_id
     JOIN alert_rules dr ON dr.id = sa.depends_on_rule_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY sa.suppressed_at DESC
     LIMIT 100`,
    params
  );
  return result.rows;
});


// Bir cihazın tüm kuralları (şablondan gelen + ad-hoc) — cihaz bazlı yönetim için
app.get("/api/v1/devices/:id/alert-rules", async (request) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  const result = await pool.query(
    `SELECT r.id, r.metric_name, r.condition, r.threshold, r.duration_seconds, r.severity, r.active,
            r.anomaly_enabled, r.anomaly_sigma, r.anomaly_seasonal, r.predictive_enabled, r.predictive_horizon_hours,
            r.escalation_policy_id, ep.name as escalation_policy_name,
            (r.template_rule_id IS NOT NULL) as from_template
     FROM alert_rules r
     LEFT JOIN escalation_policies ep ON ep.id = r.escalation_policy_id
     WHERE r.tenant_id = $1 AND r.device_id = $2 AND r.is_heartbeat = false AND r.is_anomaly = false AND r.is_predictive = false ORDER BY r.metric_name`,
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
  severity: z.enum(["info", "warning", "average", "high", "disaster", "critical"]).default("warning")
});

// Anomali Tespiti opt-out -- kullanıcı gürültülü/volatil bir metrik için
// anomali izlemeyi kapatabilsin (Datadog'un monitör-bazlı mute deseniyle AYNI
// mantık). Kapatılınca: varsa gölge kural active=false yapılır VE açık
// anomali alarmları çözülür (kapatılan bir izlemenin alarmı açık kalmamalı).
// Açılınca: varsa gölge kural tekrar active=true yapılır (henüz hiç
// alarm-engine turu çalışmadıysa gölge kural olmayabilir, sorun değil --
// bir sonraki turda otomatik oluşturulur).
// sigma/seasonal: anomaly detection iyileştirmeleri -- kural-bazlı sigma
// override (1-10 arası makul bir aralık, varsayılan/global 3'e karşılık) ve
// opt-in saatlik mevsimsel baseline (predictive-analytics endpoint'iyle AYNI
// "sadece gönderilen alan güncellenir" deseni).
const SetAnomalyDetectionSchema = z.object({
  enabled: z.boolean().optional(),
  sigma: z.number().min(1).max(10).nullable().optional(), // null = override'ı kaldır, global varsayılana dön
  seasonal: z.boolean().optional()
});
app.patch("/api/v1/alert-rules/:id/anomaly-detection", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const parsed = SetAnomalyDetectionSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  if (parsed.data.enabled === undefined && parsed.data.sigma === undefined && parsed.data.seasonal === undefined) {
    return reply.status(400).send({ error: "enabled, sigma veya seasonal belirtilmeli" });
  }

  const ruleCheck = await pool.query(`SELECT id FROM alert_rules WHERE tenant_id = $1 AND id = $2 AND is_anomaly = false`, [auth.tenantId, id]);
  if (ruleCheck.rows.length === 0) return reply.status(404).send({ error: "Kural bulunamadı" });

  if (parsed.data.sigma !== undefined) {
    await pool.query(`UPDATE alert_rules SET anomaly_sigma = $1 WHERE id = $2`, [parsed.data.sigma, id]);
  }
  if (parsed.data.seasonal !== undefined) {
    await pool.query(`UPDATE alert_rules SET anomaly_seasonal = $1 WHERE id = $2`, [parsed.data.seasonal, id]);
  }

  if (parsed.data.enabled !== undefined) {
    await pool.query(`UPDATE alert_rules SET anomaly_enabled = $1 WHERE id = $2`, [parsed.data.enabled, id]);

    if (!parsed.data.enabled) {
      const shadowRule = await pool.query(`SELECT id FROM alert_rules WHERE source_rule_id = $1 AND is_anomaly = true`, [id]);
      if (shadowRule.rows.length > 0) {
        const shadowRuleId = shadowRule.rows[0].id;
        await pool.query(`UPDATE alert_rules SET active = false WHERE id = $1`, [shadowRuleId]);
        await pool.query(`UPDATE alerts SET resolved_at = now() WHERE rule_id = $1 AND resolved_at IS NULL`, [shadowRuleId]);
      }
    } else {
      await pool.query(`UPDATE alert_rules SET active = true WHERE source_rule_id = $1 AND is_anomaly = true`, [id]);
    }
  }

  const updated = await pool.query(`SELECT anomaly_enabled, anomaly_sigma, anomaly_seasonal FROM alert_rules WHERE id = $1`, [id]);
  return { id, ...updated.rows[0] };
});

// Predictive Analytics opt-out + kural başına ufuk ayarı -- anomaly-detection
// endpoint'iyle AYNI mantık, tek fark enabled yanında horizon_hours da
// güncellenebiliyor (ikisi de opsiyonel, sadece gönderilen alan güncellenir).
const SetPredictiveAnalyticsSchema = z.object({
  enabled: z.boolean().optional(),
  horizon_hours: z.number().int().min(1).max(720).optional() // 1 saat - 30 gün arası makul bir aralık
});
app.patch("/api/v1/alert-rules/:id/predictive-analytics", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const parsed = SetPredictiveAnalyticsSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  if (parsed.data.enabled === undefined && parsed.data.horizon_hours === undefined) {
    return reply.status(400).send({ error: "enabled veya horizon_hours belirtilmeli" });
  }

  const ruleCheck = await pool.query(`SELECT id FROM alert_rules WHERE tenant_id = $1 AND id = $2 AND is_predictive = false`, [auth.tenantId, id]);
  if (ruleCheck.rows.length === 0) return reply.status(404).send({ error: "Kural bulunamadı" });

  if (parsed.data.horizon_hours !== undefined) {
    await pool.query(`UPDATE alert_rules SET predictive_horizon_hours = $1 WHERE id = $2`, [parsed.data.horizon_hours, id]);
  }

  if (parsed.data.enabled !== undefined) {
    await pool.query(`UPDATE alert_rules SET predictive_enabled = $1 WHERE id = $2`, [parsed.data.enabled, id]);

    if (!parsed.data.enabled) {
      const shadowRule = await pool.query(`SELECT id FROM alert_rules WHERE source_rule_id = $1 AND is_predictive = true`, [id]);
      if (shadowRule.rows.length > 0) {
        const shadowRuleId = shadowRule.rows[0].id;
        await pool.query(`UPDATE alert_rules SET active = false WHERE id = $1`, [shadowRuleId]);
        await pool.query(`UPDATE alerts SET resolved_at = now() WHERE rule_id = $1 AND resolved_at IS NULL`, [shadowRuleId]);
      }
    } else {
      await pool.query(`UPDATE alert_rules SET active = true WHERE source_rule_id = $1 AND is_predictive = true`, [id]);
    }
  }

  const updated = await pool.query(`SELECT predictive_enabled, predictive_horizon_hours FROM alert_rules WHERE id = $1`, [id]);
  return { id, ...updated.rows[0] };
});

app.patch("/api/v1/alert-rules/:id/escalation-policy", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const ruleCheck = await pool.query(`SELECT id FROM alert_rules WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  if (ruleCheck.rows.length === 0) return reply.status(404).send({ error: "Kural bulunamadı" });

  const parsed = SetEscalationPolicySchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  if (parsed.data.policy_id && !(await escalationPolicyBelongsToTenant(parsed.data.policy_id, auth.tenantId))) {
    return reply.status(404).send({ error: "Politika bulunamadı" });
  }
  await pool.query(`UPDATE alert_rules SET escalation_policy_id = $1 WHERE id = $2`, [parsed.data.policy_id, id]);
  return { id, escalation_policy_id: parsed.data.policy_id };
});

app.post("/api/v1/devices/:id/alert-rules", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  const parsed = CreateDeviceRuleSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { metric_name, condition, threshold, duration_seconds, severity } = parsed.data;

  if (!(await idBelongsToTenant("devices", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Cihaz bulunamadı" });
  }

  // GERCEK BUG DUZELTMESI: bu endpoint hicbir duplicate kontrolu yapmadan dogrudan
  // INSERT yapiyordu -- ayni cihaza, ayni (metric_name, condition, threshold) ile
  // "Kural ekle" formundan yanlislikla birden fazla kez kural eklenebiliyordu (gercek
  // veride 3 birebir ayni kural bulundu, alarm listesinde ayni sorun 3 kez gorunuyordu).
  const existingRule = await pool.query(
    `SELECT id FROM alert_rules WHERE device_id = $1 AND metric_name = $2 AND condition = $3 AND threshold = $4`,
    [id, metric_name, condition, threshold]
  );
  if (existingRule.rows.length > 0) {
    return reply.status(409).send({ error: "Bu metrik/koşul/eşik için zaten bir kural tanımlı" });
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
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

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
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

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
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

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
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
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
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

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
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
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
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

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
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM maintenance_windows WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});


app.get("/api/v1/audit-log", async (request, reply) => {
  const auth = (request as any).auth;
  // GERÇEK HATA DÜZELTMESİ (kullanıcı yönetimi denetiminde bulundu): "audit_log"
  // ALL_RESOURCES'ta ayrı bir kaynak olarak tanımlı ve rol yönetimi ekranında
  // "Denetim kaydı" diye ayrı bir izin olarak gösteriliyordu, ama bu endpoint
  // yanlışlıkla "users" kaynağını kontrol ediyordu -- yani o toggle hiçbir işe
  // yaramıyordu, ve "users: read_write" izni olan HERKES otomatik olarak audit
  // log'u da görebiliyordu (istenmeyen yan etki).
  if (!hasPermission(auth, "audit_log", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

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
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  if (await templateIsProtected(id)) return reply.status(403).send(PROTECTED_TEMPLATE_ERROR);
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
  severity: z.enum(["info", "warning", "average", "high", "disaster", "critical"]).optional(),
  depends_on_template_rule_id: z.string().uuid().nullable().optional(),
  recovery_threshold: z.number().nullable().optional(),
  tags: z.array(z.object({ tag: z.string(), value: z.string() })).optional(),
  // FAZ J.0: hangi kolona göre (interface/instance_label) instance-bazlı gruplanacağını
  // seçer. NULL = eski davranış (cihaz-seviyesi tek alarm).
  instance_tag_key: z.enum(["interface", "instance_label"]).nullable().optional()
});

// Yardımcı: alert_template_rules.id -> template_id -> alert_templates.tenant_id zincirini
// doğrulayan tenant sahiplik kontrolü (GÜVENLİK DÜZELTMESİ: önceden bu endpoint'ler sadece
// rol iznini kontrol ediyordu, kaydın çağıranın tenant'ına ait olduğunu HİÇ doğrulamıyordu
// -- başka bir tenant'ın kural id'sini bilen/tahmin eden bir kullanıcı onu değiştirebilir/
// silebilirdi. Kod tabanında zaten var olan idBelongsToTenant desenini burada da uyguluyoruz).
async function templateRuleBelongsToTenant(ruleId: string, tenantId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT atr.id FROM alert_template_rules atr
     JOIN alert_templates t ON t.id = atr.template_id
     WHERE atr.id = $1 AND t.tenant_id = $2`,
    [ruleId, tenantId]
  );
  return result.rows.length > 0;
}

app.patch("/api/v1/alert-template-rules/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  if (!(await templateRuleBelongsToTenant(id, auth.tenantId))) {
    return reply.status(404).send({ error: "Kural bulunamadı" });
  }
  if (await templateRuleIsProtected(id)) return reply.status(403).send(PROTECTED_TEMPLATE_ERROR);
  const parsed = UpdateTemplateRuleSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { condition, threshold, threshold_macro_key, duration_seconds, severity, depends_on_template_rule_id, recovery_threshold, tags, instance_tag_key } = parsed.data;

  const result = await pool.query(
    `UPDATE alert_template_rules SET
       condition = COALESCE($2, condition),
       threshold = COALESCE($3, threshold),
       threshold_macro_key = $4,
       duration_seconds = COALESCE($5, duration_seconds),
       severity = COALESCE($6, severity),
       depends_on_template_rule_id = $7,
       recovery_threshold = COALESCE($8, recovery_threshold),
       tags = COALESCE($9, tags),
       instance_tag_key = $10
     WHERE id = $1
     RETURNING id, metric_name, condition, threshold, duration_seconds, severity, threshold_macro_key, depends_on_template_rule_id, recovery_threshold, tags, instance_tag_key`,
    [id, condition, threshold, threshold_macro_key, duration_seconds, severity, depends_on_template_rule_id, recovery_threshold, tags ? JSON.stringify(tags) : null, instance_tag_key]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Kural bulunamadı" });
  return result.rows[0];
});

// policy_id ZORUNLU (undefined değil) -- explicit null = eskalasyonu kaldır,
// bir uuid = ata. Bu tek-alanlı endpoint için tri-state numarasına gerek yok
// (title/predictive_horizon_hours gibi çoklu-alanlı PATCH'lerin aksine).
const SetEscalationPolicySchema = z.object({ policy_id: z.string().uuid().nullable() });

app.patch("/api/v1/alert-template-rules/:id/escalation-policy", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  if (!(await templateRuleBelongsToTenant(id, auth.tenantId))) {
    return reply.status(404).send({ error: "Kural bulunamadı" });
  }
  const parsed = SetEscalationPolicySchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  if (parsed.data.policy_id && !(await escalationPolicyBelongsToTenant(parsed.data.policy_id, auth.tenantId))) {
    return reply.status(404).send({ error: "Politika bulunamadı" });
  }
  await pool.query(`UPDATE alert_template_rules SET escalation_policy_id = $1 WHERE id = $2`, [parsed.data.policy_id, id]);
  return { id, escalation_policy_id: parsed.data.policy_id };
});

app.delete("/api/v1/alert-template-rules/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  if (!(await templateRuleBelongsToTenant(id, auth.tenantId))) {
    return reply.status(404).send({ error: "Kural bulunamadı" });
  }
  if (await templateRuleIsProtected(id)) return reply.status(403).send(PROTECTED_TEMPLATE_ERROR);
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
  severity: z.enum(["info", "warning", "average", "high", "disaster", "critical"]).default("warning"),
  tags: z.array(z.object({ tag: z.string(), value: z.string() })).default([]),
  recovery_threshold: z.number().optional(),
  expression_ast: z.record(z.any()).optional(),
  display_expression: z.string().optional(),
  // FAZ J.0: is_table:true item'lardan üretilen kurallar (örn. SNMP interface
  // alarmları, ileride VMware/Hyper-V) bunu 'interface'/'instance_label' olarak
  // set eder -- NULL (varsayılan) mevcut tüm kuralları etkilemez.
  instance_tag_key: z.enum(["interface", "instance_label"]).optional()
}).refine(
  (data) => (data.metric_name && data.condition) || data.expression_ast,
  { message: "metric_name+condition YA DA expression_ast dolu olmali" }
);
app.post("/api/v1/alert-templates/:id/rules", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  if (await templateIsProtected(id)) return reply.status(403).send(PROTECTED_TEMPLATE_ERROR);
  const parsed = AddTemplateRuleSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { metric_name, condition, threshold, threshold_macro_key, duration_seconds, severity, tags, recovery_threshold, expression_ast, display_expression, instance_tag_key } = parsed.data;
  const result = await pool.query(
    `INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity, threshold_macro_key, tags, recovery_threshold, expression_ast, display_expression, instance_tag_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, metric_name, condition, threshold, duration_seconds, severity, tags, recovery_threshold, expression_ast, display_expression, instance_tag_key`,
    [id, metric_name || null, condition || null, threshold ?? null, duration_seconds, severity, threshold_macro_key || null, JSON.stringify(tags), recovery_threshold || null, expression_ast ? JSON.stringify(expression_ast) : null, display_expression || null, instance_tag_key || null]
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
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  if (await templateItemIsProtected(id)) return reply.status(403).send(PROTECTED_TEMPLATE_ERROR);
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


// FAZ J: VMware collector'ının kendine özel cihaz listesi. Genel /internal/devices
// endpoint'i (collector_type filtresiyle) LEFT JOIN kullanıyor -- vmware interface'i
// olmayan cihazları da (devices.ip_address'e geri düşerek) gevşek şekilde dahil
// edebiliyor, ki SQL/SSH'ta zamanlama/item katmanı bunu zararsız hale getiriyor
// (öyle bir item hiç olmadığı için hiçbir şey toplanmıyor). VMware ise item-bazlı
// zamanlama modelini KULLANMIYOR (bir API çağrısıyla TÜM VM'ler alınıyor) -- bu
// yüzden burada BİLEREK INNER JOIN kullanılıyor: sadece GERÇEKTEN 'vmware' interface'i
// tanımlı cihazlar dönüyor, ve vmware_mode/tls_skip_verify de birlikte geliyor.
app.get("/api/v1/internal/vmware-devices", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const result = await pool.query(
    `SELECT d.id, d.tenant_id, d.name, di.ip_address, di.port, di.vmware_mode, di.tls_skip_verify
     FROM devices d
     JOIN device_interfaces di ON di.device_id = d.id AND di.interface_type = 'vmware'
     WHERE d.status IN ('active', 'down', 'unknown') AND d.enabled = true`
  );
  return result.rows;
});

// FAZ J: bir instance (VM/datastore/vb.) izleme kaynağından (VMware, gelecekte
// Hyper-V) KAYBOLDUĞUNDA -- silinmiş/taşınmış, artık envanterde yok -- o instance'a
// ait TÜM açık alarmları (hangi kuraldan gelirse gelsin) toplu kapatır. Normal
// evaluateRuleForDevice akışından FARKLI: burada "koşul artık ihlal edilmiyor" değil,
// "bu instance'ın kendisi artık yok" durumu var -- collector'lar N ardışık turda
// görünmeyen bir instance'ı tespit edip bunu çağırır (bkz. vmware-collector/src/index.ts
// MISSING_THRESHOLD_TICKS).
app.post("/api/v1/internal/alerts/resolve-by-tag", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const { device_id, instance_tag_value } = request.body as { device_id?: string; instance_tag_value?: string };
  if (!device_id || !instance_tag_value) {
    return reply.status(400).send({ error: "device_id ve instance_tag_value gerekli" });
  }

  const resolved = await pool.query(
    `UPDATE alerts SET resolved_at = now()
     WHERE device_id = $1 AND instance_tag_value = $2 AND resolved_at IS NULL
     RETURNING id, rule_id, metric_name`,
    [device_id, instance_tag_value]
  );

  console.log(`[Internal] resolve-by-tag: device=${device_id} instance=${instance_tag_value} -- ${resolved.rows.length} alarm kapatıldı`);
  return { resolved_count: resolved.rows.length, alert_ids: resolved.rows.map((r) => r.id) };
});

// ============ VMware Host/Cluster Hiyerarşi Senkronizasyonu ============
// KULLANICI GERİ BİLDİRİMİ İLE EKLENDİ: host'lar sayıca az olduğu için gerçek devices
// satırlarına yükseltiliyor, cluster'lar mevcut device_groups sistemiyle temsil
// ediliyor -- yeni bir hiyerarşi kavramı İCAT EDİLMİYOR, Faz 1-4'te kurulan
// device_groups + user_group_device_permissions aynen kullanılıyor.

const VMwareSyncHostSchema = z.object({
  tenant_id: z.string().uuid(),
  vmware_host_id: z.string().min(1), // vSphere host MOID (örn. "host-1")
  name: z.string().min(1),
  ip_address: z.string().optional()
});

// vmware-collector her turda çağırır -- vmware_host_id ile find-or-create (idempotent).
// APM Adım 6: apm-collector her yeni servis gördüğünde çağırır -- servisi
// devices tablosuna device_type='service' olarak find-or-create eder (VMware
// host senkronizasyonuyla AYNI desen: link-local placeholder IP, attributes
// JSONB üzerinden idempotent anahtar). host_name verilmişse (OTel'in
// resource.attributes'ındaki host.name), o isimle eşleşen bir cihaz aranır
// ve device_links'e discovery_method='service_host' ile bağlanır -- BU SAYEDE
// computeRootCauseCandidates'ın adjacency CTE'si servis<->host ilişkisini
// OTOMATİK olarak kök-neden zincirine dahil eder, RCA motorunda hiçbir yeni
// kod gerekmez.
const ApmSyncServiceSchema = z.object({
  tenant_id: z.string().uuid(),
  service_name: z.string().min(1),
  host_name: z.string().optional()
});
app.post("/api/v1/internal/apm-sync/service", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });
  const parsed = ApmSyncServiceSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { tenant_id, service_name, host_name } = parsed.data;

  const existing = await pool.query(
    `SELECT id FROM devices WHERE tenant_id = $1 AND device_type = 'service' AND attributes->>'apm_service_name' = $2`,
    [tenant_id, service_name]
  );

  let serviceDeviceId: string;
  let created = false;
  if (existing.rows.length > 0) {
    serviceDeviceId = existing.rows[0].id;
  } else {
    // devices.ip_address NOT NULL -- servislerin gerçek bir IP'si yok (metrik
    // toplama zaten trace verisi üzerinden yapılıyor, SNMP/ICMP değil) --
    // VMware host senkronizasyonuyla AYNI link-local placeholder deseni.
    const placeholderIp = `169.254.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    const inserted = await pool.query(
      `INSERT INTO devices (tenant_id, name, ip_address, device_type, attributes)
       VALUES ($1, $2, $3, 'service', $4) RETURNING id`,
      [tenant_id, service_name, placeholderIp, JSON.stringify({ apm_service_name: service_name })]
    );
    serviceDeviceId = inserted.rows[0].id;
    created = true;
  }

  let linkedHostId: string | null = null;
  if (host_name) {
    const hostResult = await pool.query(
      `SELECT id FROM devices WHERE tenant_id = $1 AND name = $2 AND device_type != 'service'`,
      [tenant_id, host_name]
    );
    if (hostResult.rows.length > 0) {
      linkedHostId = hostResult.rows[0].id;
      await pool.query(
        `INSERT INTO device_links (tenant_id, device_a_id, device_b_id, discovery_method)
         VALUES ($1, $2, $3, 'service_host')
         ON CONFLICT (tenant_id, LEAST(device_a_id, device_b_id), GREATEST(device_a_id, device_b_id), COALESCE(interface_a, ''), COALESCE(interface_b, ''))
         DO NOTHING`,
        [tenant_id, serviceDeviceId, linkedHostId]
      );
    }
  }

  return { id: serviceDeviceId, created, linked_host_id: linkedHostId };
});

app.post("/api/v1/internal/vmware-sync/host", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const parsed = VMwareSyncHostSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { tenant_id, vmware_host_id, name, ip_address } = parsed.data;

  const existing = await pool.query(
    `SELECT id FROM devices WHERE tenant_id = $1 AND attributes->>'vmware_host_id' = $2`,
    [tenant_id, vmware_host_id]
  );
  if (existing.rows.length > 0) {
    await pool.query(`UPDATE devices SET name = $2 WHERE id = $1`, [existing.rows[0].id, name]);
    return { id: existing.rows[0].id, created: false };
  }

  // devices.ip_address NOT NULL -- vSphere host objesi her zaman IP vermeyebilir,
  // bu durumda anlamsız ama benzersiz bir yer tutucu kullanılıyor (bu cihaz zaten
  // gerçek metrik toplama için ip_address'ini KULLANMIYOR -- vmware-collector,
  // vCenter'ın KENDİ ip_address'i üzerinden bağlanıp API'den veri çekiyor).
  const finalIp = ip_address || `169.254.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  const inserted = await pool.query(
    `INSERT INTO devices (tenant_id, name, ip_address, device_type, attributes)
     VALUES ($1, $2, $3, 'server', $4) RETURNING id`,
    [tenant_id, name, finalIp, JSON.stringify({ vmware_host_id })]
  );
  const newDeviceId = inserted.rows[0].id;

  // KULLANICI GERİ BİLDİRİMİYLE EKLENDİ (Adım 9, host-seviyesi kurallar): yeni
  // senkronize edilen HER host'a, sabit isimle aranan "VMware Host İzleme"
  // template'i (varsa) OTOMATİK uygulanır -- kullanıcı elle her host'a tek tek
  // template atamak zorunda kalmaz. Template YOKSA (henüz oluşturulmamışsa)
  // sessizce atlanır, hata değildir (opsiyonel bir kolaylık, zorunlu değil).
  const hostTemplateResult = await pool.query(
    `SELECT id FROM alert_templates WHERE tenant_id = $1 AND name = 'VMware Host İzleme'`,
    [tenant_id]
  );
  if (hostTemplateResult.rows.length > 0) {
    const templateId = hostTemplateResult.rows[0].id;
    await pool.query(
      `INSERT INTO device_templates (device_id, template_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [newDeviceId, templateId]
    );
    const rulesResult = await pool.query(
      `SELECT id, metric_name, condition, threshold, duration_seconds, severity, depends_on_template_rule_id, threshold_macro_key, expression_ast, display_expression, instance_tag_key, escalation_policy_id
       FROM alert_template_rules WHERE template_id = $1`,
      [templateId]
    );
    if (rulesResult.rows.length > 0) {
      await applyTemplateRulesToDevices(rulesResult, [newDeviceId], tenant_id);
    }
  }

  return reply.status(201).send({ id: newDeviceId, created: true });
});

const VMwareSyncGroupSchema = z.object({
  tenant_id: z.string().uuid(),
  vmware_source_device_id: z.string().uuid(), // bu grubu "yöneten" vCenter cihazı
  vmware_external_id: z.string().min(1), // 'all-hosts' veya cluster MOID
  name: z.string().min(1)
});

app.post("/api/v1/internal/vmware-sync/group", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const parsed = VMwareSyncGroupSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { tenant_id, vmware_source_device_id, vmware_external_id, name } = parsed.data;

  const result = await pool.query(
    `INSERT INTO device_groups (tenant_id, name, vmware_source_device_id, vmware_external_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (vmware_source_device_id, vmware_external_id) WHERE vmware_source_device_id IS NOT NULL
     DO UPDATE SET name = $2
     RETURNING id`,
    [tenant_id, name, vmware_source_device_id, vmware_external_id]
  );
  return result.rows[0];
});

app.post("/api/v1/internal/vmware-sync/group-membership", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const { device_group_id, device_id } = request.body as { device_group_id?: string; device_id?: string };
  if (!device_group_id || !device_id) return reply.status(400).send({ error: "device_group_id ve device_id gerekli" });

  await pool.query(
    `INSERT INTO device_group_members (device_group_id, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [device_group_id, device_id]
  );
  return reply.status(204).send();
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

// Yardımcı: template_item_id -> template_id -> alert_templates.tenant_id zincirini doğrular
// (GÜVENLİK DÜZELTMESİ: bkz. templateRuleBelongsToTenant ile aynı gerekçe).
async function templateItemBelongsToTenant(templateItemId: string, tenantId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT ti.id FROM template_items ti
     JOIN alert_templates t ON t.id = ti.template_id
     WHERE ti.id = $1 AND t.tenant_id = $2`,
    [templateItemId, tenantId]
  );
  return result.rows.length > 0;
}

app.get("/api/v1/template-items/:id/preprocessing", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  if (!(await templateItemBelongsToTenant(id, auth.tenantId))) {
    return reply.status(404).send({ error: "Item bulunamadı" });
  }
  const result = await pool.query(
    `SELECT id, step_order, step_type, params FROM item_preprocessing_steps WHERE template_item_id = $1 ORDER BY step_order`,
    [id]
  );
  return result.rows;
});

app.post("/api/v1/template-items/:id/preprocessing", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  if (!(await templateItemBelongsToTenant(id, auth.tenantId))) {
    return reply.status(404).send({ error: "Item bulunamadı" });
  }
  if (await templateItemIsProtected(id)) return reply.status(403).send(PROTECTED_TEMPLATE_ERROR);
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
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const ownerCheck = await pool.query(
    `SELECT ips.id, t.is_protected FROM item_preprocessing_steps ips
     JOIN template_items ti ON ti.id = ips.template_item_id
     JOIN alert_templates t ON t.id = ti.template_id
     WHERE ips.id = $1 AND t.tenant_id = $2`,
    [id, auth.tenantId]
  );
  if (ownerCheck.rows.length === 0) return reply.status(404).send({ error: "Adım bulunamadı" });
  if (ownerCheck.rows[0].is_protected) return reply.status(403).send(PROTECTED_TEMPLATE_ERROR);
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
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

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
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM value_maps WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});

// Bir template item'a value map ata
app.patch("/api/v1/template-items/:id/value-map", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const { value_map_id } = request.body as { value_map_id: string | null };

  const result = await pool.query(
    `UPDATE template_items SET value_map_id = $1 WHERE id = $2 RETURNING id, value_map_id`,
    [value_map_id, id]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "Item bulunamadı" });
  return result.rows[0];
});


// ============ SYSLOG DESENLERİ (syslogReceiver.ts pattern -> metrik/alarm eşleştirmesi) ============
// Bir syslog mesajı bir desene (regex) uyunca, npm-service o desenin metric_name'iyle
// bir metrik yayınlar (instance_label = desen adı) -- kullanıcı bu metrik adı üzerinden
// MEVCUT şablon/alarm sistemiyle kural tanımlar. Yetki: value-maps ile aynı model
// (alert_rules read_write) -- ayrı bir izin kaynağı eklemeye gerek yok.

const SyslogPatternSchema = z.object({
  name: z.string().min(1),
  regex: z.string().min(1),
  // metric_name güvenli bir tanımlayıcı olmalı -- alarm kuralları bununla eşleşir.
  metric_name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "metric_name harfle başlamalı, sadece harf/rakam/alt çizgi içerebilir"),
  min_severity: z.number().int().min(0).max(7).default(7),
  enabled: z.boolean().default(true)
});

app.get("/api/v1/syslog-patterns", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT id, name, regex, metric_name, min_severity, enabled, created_at
     FROM syslog_patterns WHERE tenant_id = $1 ORDER BY name`,
    [auth.tenantId]
  );
  return result.rows;
});

app.post("/api/v1/syslog-patterns", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const parsed = SyslogPatternSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  // Regex'i sunucu tarafında da derle -- geçersizse kullanıcıya net hata dön (yoksa
  // sadece collector loglarında sessizce atlanırdı).
  try { new RegExp(parsed.data.regex); }
  catch { return reply.status(400).send({ error: "Geçersiz regex ifadesi" }); }

  try {
    const result = await pool.query(
      `INSERT INTO syslog_patterns (tenant_id, name, regex, metric_name, min_severity, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, regex, metric_name, min_severity, enabled, created_at`,
      [auth.tenantId, parsed.data.name, parsed.data.regex, parsed.data.metric_name, parsed.data.min_severity, parsed.data.enabled]
    );
    return reply.status(201).send(result.rows[0]);
  } catch (err: any) {
    if (err.code === "23505") return reply.status(409).send({ error: "Bu isimde bir syslog deseni zaten var" });
    throw err;
  }
});

app.put("/api/v1/syslog-patterns/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };

  const parsed = SyslogPatternSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  try { new RegExp(parsed.data.regex); }
  catch { return reply.status(400).send({ error: "Geçersiz regex ifadesi" }); }

  try {
    const result = await pool.query(
      `UPDATE syslog_patterns SET name = $1, regex = $2, metric_name = $3, min_severity = $4, enabled = $5
       WHERE id = $6 AND tenant_id = $7
       RETURNING id, name, regex, metric_name, min_severity, enabled, created_at`,
      [parsed.data.name, parsed.data.regex, parsed.data.metric_name, parsed.data.min_severity, parsed.data.enabled, id, auth.tenantId]
    );
    if (result.rows.length === 0) return reply.status(404).send({ error: "Desen bulunamadı" });
    return result.rows[0];
  } catch (err: any) {
    if (err.code === "23505") return reply.status(409).send({ error: "Bu isimde bir syslog deseni zaten var" });
    throw err;
  }
});

app.delete("/api/v1/syslog-patterns/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM syslog_patterns WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
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
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

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
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const ownerCheck = await pool.query(
    `SELECT ws.id FROM web_scenarios ws
     JOIN alert_templates t ON t.id = ws.template_id
     WHERE ws.id = $1 AND t.tenant_id = $2`,
    [id, auth.tenantId]
  );
  if (ownerCheck.rows.length === 0) return reply.status(404).send({ error: "Senaryo bulunamadı" });
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
// RCA Adım 4: yeni bir alarm açıldığında alarm-engine bu endpoint'i çağırır. deviceId'nin
// (alarmın tetiklendiği cihaz) en olası kök-neden komşusunu bulur; confidence>60 ise bir
// incident'a bağlar (yoksa oluşturur, varsa etkilenen alarmı ekler).
app.post("/api/v1/internal/root-cause-check", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const body = request.body as { tenantId?: string; deviceId?: string; alertId?: string };
  if (!body?.tenantId || !body?.deviceId || !body?.alertId) {
    return reply.status(400).send({ error: "tenantId, deviceId ve alertId gerekli" });
  }
  const { tenantId, deviceId, alertId } = body;

  // candidates confidence'a göre azalan sıralı -> en olası kök-neden [0].
  const { candidates } = await computeRootCauseCandidates(pool, tenantId, deviceId);
  const top = candidates[0];
  if (!top || top.confidence <= 60) return { incident: null };

  const rootCauseDeviceId = top.id;
  const rootCauseAlertId = top.open_alert_id; // adayın en eski açık alarmı
  const conf = top.confidence;
  const pathDeviceIds = top.path.map((p) => p.id);

  const existing = await pool.query(
    `SELECT id FROM incidents WHERE tenant_id = $1 AND root_cause_device_id = $2 AND status = 'open' LIMIT 1`,
    [tenantId, rootCauseDeviceId]
  );

  let incidentId: string;
  let created = false;
  if (existing.rows.length > 0) {
    incidentId = existing.rows[0].id;
    await pool.query(`UPDATE incidents SET updated_at = now() WHERE id = $1`, [incidentId]);
  } else {
    const inserted = await pool.query(
      `INSERT INTO incidents (
         tenant_id, root_cause_device_id, root_cause_alert_id, confidence, status,
         relationship_weight, temporal_score, hierarchy_weight, hop_decay, hop_distance, path_device_ids
       )
       VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        tenantId, rootCauseDeviceId, rootCauseAlertId, conf,
        top.relationship_weight, top.temporal_score, top.hierarchy_weight, top.hop_decay, top.hop_distance, pathDeviceIds
      ]
    );
    incidentId = inserted.rows[0].id;
    created = true;
  }

  // Tetikleyen alarmı (deviceId üzerindeki alertId) etkilenen alarm olarak ekle.
  await pool.query(
    `INSERT INTO incident_affected_alerts (
       incident_id, alert_id, device_id, confidence,
       relationship_weight, temporal_score, hierarchy_weight, hop_decay, hop_distance, path_device_ids
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (incident_id, alert_id) DO NOTHING`,
    [
      incidentId, alertId, deviceId, conf,
      top.relationship_weight, top.temporal_score, top.hierarchy_weight, top.hop_decay, top.hop_distance, pathDeviceIds
    ]
  );

  return { incident: { id: incidentId, created, root_cause_device_id: rootCauseDeviceId, confidence: conf } };
});

// RCA Adım 5: incident listesi -- confidence eşiğini aşan kök-neden korelasyonlarının
// global görünümü (mevcut /api/v1/devices ile AYNI pagination/filtre deseni).
app.get("/api/v1/incidents", async (request) => {
  const auth = (request as any).auth;
  const query = request.query as { status?: string; root_cause_device_id?: string; limit?: string; page?: string };

  const conditions: string[] = ["i.tenant_id = $1"];
  const params: any[] = [auth.tenantId];
  let paramIndex = 2;

  if (query.status) {
    conditions.push(`i.status = $${paramIndex}`);
    params.push(query.status);
    paramIndex++;
  }
  // Frontend: DeviceDetail sayfasının "bu cihaz açık bir incident'ın kök nedeni mi"
  // sorgusu için (RCA Adım 6 -- "Bu olayın parçası" linki).
  if (query.root_cause_device_id) {
    conditions.push(`i.root_cause_device_id = $${paramIndex}`);
    params.push(query.root_cause_device_id);
    paramIndex++;
  }

  const limit = Math.min(Number(query.limit) || 50, 200);
  const page = Math.max(Number(query.page) || 1, 1);
  const offset = (page - 1) * limit;

  const result = await pool.query(
    `SELECT i.id, i.root_cause_device_id, rcd.name as root_cause_device_name,
            i.confidence, i.status, i.created_at, i.updated_at, i.resolved_at,
            i.relationship_weight, i.temporal_score, i.hierarchy_weight, i.hop_decay, i.hop_distance,
            COUNT(*) OVER()::int as total_count,
            (SELECT COUNT(*)::int FROM incident_affected_alerts iaa WHERE iaa.incident_id = i.id) as affected_count
     FROM incidents i
     LEFT JOIN devices rcd ON rcd.id = i.root_cause_device_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY i.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  const total = result.rows[0]?.total_count ?? 0;
  const items = result.rows.map(({ total_count, ...rest }) => rest);

  return { items, total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) };
});

// RCA Adım 5: incident detayı -- kök-neden cihazı/alarmı + etkilenen tüm
// cihaz/alarm çiftleri (incident_affected_alerts join'lenmiş).
app.get("/api/v1/incidents/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };

  const incidentResult = await pool.query(
    `SELECT i.id, i.tenant_id, i.root_cause_device_id, rcd.name as root_cause_device_name,
            i.root_cause_alert_id, rca.message as root_cause_alert_message,
            rca.triggered_at as root_cause_alert_triggered_at, rca.resolved_at as root_cause_alert_resolved_at,
            i.confidence, i.status, i.created_at, i.updated_at, i.resolved_at,
            i.relationship_weight, i.temporal_score, i.hierarchy_weight, i.hop_decay, i.hop_distance,
            i.path_device_ids,
            (SELECT array_agg(pd.name ORDER BY p.ord)
             FROM unnest(i.path_device_ids) WITH ORDINALITY AS p(pid, ord)
             JOIN devices pd ON pd.id = p.pid) as path_device_names
     FROM incidents i
     LEFT JOIN devices rcd ON rcd.id = i.root_cause_device_id
     LEFT JOIN alerts rca ON rca.id = i.root_cause_alert_id
     WHERE i.tenant_id = $1 AND i.id = $2`,
    [auth.tenantId, id]
  );
  if (incidentResult.rows.length === 0) return reply.status(404).send({ error: "Olay bulunamadı" });

  const affectedResult = await pool.query(
    `SELECT iaa.id, iaa.alert_id, iaa.device_id, d.name as device_name, iaa.confidence, iaa.added_at,
            a.message as alert_message, a.severity as alert_severity,
            a.triggered_at as alert_triggered_at, a.resolved_at as alert_resolved_at,
            iaa.relationship_weight, iaa.temporal_score, iaa.hierarchy_weight, iaa.hop_decay, iaa.hop_distance
     FROM incident_affected_alerts iaa
     JOIN devices d ON d.id = iaa.device_id
     JOIN alerts a ON a.id = iaa.alert_id
     WHERE iaa.incident_id = $1
     ORDER BY iaa.added_at ASC`,
    [id]
  );

  return {
    ...incidentResult.rows[0],
    affected_alerts: affectedResult.rows
  };
});

app.post("/api/v1/internal/verify-api-token", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const { token } = request.body as { token: string };
  const tokenHash = hashApiToken(token);

  const result = await pool.query(
    `SELECT at.id, at.tenant_id, at.user_id, at.expires_at, at.revoked_at, u.email, u.role_id
     FROM api_tokens at
     JOIN users u ON u.id = at.user_id
     WHERE at.token_hash = $1`,
    [tokenHash]
  );

  if (result.rows.length === 0) return reply.status(401).send({ error: "Geçersiz token" });
  const row = result.rows[0];
  if (row.revoked_at) return reply.status(401).send({ error: "Token iptal edilmiş" });
  if (row.expires_at && new Date(row.expires_at) < new Date()) return reply.status(401).send({ error: "Token süresi dolmuş" });

  await pool.query(`UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, [row.id]);

  const permissions = await resolvePermissionsForRole(row.role_id);
  return {
    userId: row.user_id, tenantId: row.tenant_id, email: row.email, roleId: row.role_id, permissions
  };
});


// ============ USER GROUPS (Zabbix'teki "user group" modeli) ============
// Rol (yetki seviyesi) ile grup (veri erişimi + auth ayarları) ayrıştırıldı.
// Bir kullanıcı BİRDEN FAZLA gruba üye olabilir; aynı device_group üzerinde
// birden fazla grubun izni çakışırsa deny > read_write > read kuralıyla birleştirilir
// (bkz. resolveDeviceGroupAccess()).

const CreateUserGroupSchema = z.object({
  name: z.string().min(1),
  frontend_access: z.enum(["system_default", "internal", "ldap", "disabled"]).default("system_default"),
  enabled: z.boolean().default(true),
  debug_mode: z.boolean().default(false)
});

app.get("/api/v1/user-groups", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "user_groups", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const result = await pool.query(
    `SELECT ug.id, ug.name, ug.frontend_access, ug.enabled, ug.debug_mode,
            COUNT(ugm.user_id)::int as member_count
     FROM user_groups ug
     LEFT JOIN user_group_members ugm ON ugm.user_group_id = ug.id
     WHERE ug.tenant_id = $1
     GROUP BY ug.id
     ORDER BY ug.name`,
    [auth.tenantId]
  );
  return result.rows;
});

app.post("/api/v1/user-groups", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "user_groups", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const parsed = CreateUserGroupSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  try {
    const result = await pool.query(
      `INSERT INTO user_groups (tenant_id, name, frontend_access, enabled, debug_mode)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, frontend_access, enabled, debug_mode`,
      [auth.tenantId, parsed.data.name, parsed.data.frontend_access, parsed.data.enabled, parsed.data.debug_mode]
    );
    return reply.status(201).send(result.rows[0]);
  } catch (err: any) {
    if (err.code === "23505") return reply.status(409).send({ error: "Bu isimde bir grup zaten var" });
    throw err;
  }
});

const UpdateUserGroupSchema = z.object({
  name: z.string().min(1).optional(),
  frontend_access: z.enum(["system_default", "internal", "ldap", "disabled"]).optional(),
  enabled: z.boolean().optional(),
  debug_mode: z.boolean().optional()
});

app.patch("/api/v1/user-groups/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "user_groups", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("user_groups", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Grup bulunamadı" });
  }
  const parsed = UpdateUserGroupSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { name, frontend_access, enabled, debug_mode } = parsed.data;
  const result = await pool.query(
    `UPDATE user_groups SET
       name = COALESCE($2, name),
       frontend_access = COALESCE($3, frontend_access),
       enabled = COALESCE($4, enabled),
       debug_mode = COALESCE($5, debug_mode)
     WHERE id = $1
     RETURNING id, name, frontend_access, enabled, debug_mode`,
    [id, name, frontend_access, enabled, debug_mode]
  );
  return result.rows[0];
});

app.delete("/api/v1/user-groups/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "user_groups", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("user_groups", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Grup bulunamadı" });
  }
  // GERÇEK EKSİKLİK DÜZELTMESİ (kullanıcı yönetimi denetiminde bulundu): rol
  // silme, role atanmış kullanıcı varsa engelleniyordu (409) ama grup silmenin
  // eşdeğer bir koruması yoktu -- üyelik/cihaz izni/tag filtresi satırları
  // sessizce cascade siliniyordu, frontend'de sadece bir confirm() uyarısı vardı.
  const membersResult = await pool.query(`SELECT COUNT(*)::int as count FROM user_group_members WHERE user_group_id = $1`, [id]);
  if (membersResult.rows[0].count > 0) {
    return reply.status(409).send({ error: "Bu grupta hâlâ üye var, önce üyeleri çıkarın veya başka bir gruba taşıyın" });
  }
  await pool.query(`DELETE FROM user_groups WHERE id = $1`, [id]);
  return reply.status(204).send();
});

// --- Üyelik (çoklu üyelik: bir kullanıcı birden fazla gruba eklenebilir) ---

app.get("/api/v1/user-groups/:id/members", async (request, reply) => {
  const auth = (request as any).auth;
  // GÜVENLİK DÜZELTMESİ (kullanıcı yönetimi denetiminde bulundu): bu endpoint
  // sadece grubun tenant'a ait olup olmadığını kontrol ediyordu, hasPermission
  // çağrısı hiç yoktu -- user_groups izni "none" olan bir kullanıcı bile grup
  // üyeliğini görebiliyordu.
  if (!hasPermission(auth, "user_groups", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("user_groups", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Grup bulunamadı" });
  }
  const result = await pool.query(
    `SELECT u.id, u.email FROM user_group_members ugm
     JOIN users u ON u.id = ugm.user_id
     WHERE ugm.user_group_id = $1 ORDER BY u.email`,
    [id]
  );
  return result.rows;
});

const AddMemberSchema = z.object({ user_id: z.string().uuid() });

app.post("/api/v1/user-groups/:id/members", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "user_groups", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("user_groups", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Grup bulunamadı" });
  }
  const parsed = AddMemberSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  if (!(await idBelongsToTenant("users", parsed.data.user_id, auth.tenantId))) {
    return reply.status(404).send({ error: "Kullanıcı bulunamadı" });
  }
  await pool.query(
    `INSERT INTO user_group_members (user_group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [id, parsed.data.user_id]
  );
  return reply.status(201).send({ ok: true });
});

app.delete("/api/v1/user-groups/:id/members/:userId", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "user_groups", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id, userId } = request.params as { id: string; userId: string };
  if (!(await idBelongsToTenant("user_groups", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Grup bulunamadı" });
  }
  await pool.query(`DELETE FROM user_group_members WHERE user_group_id = $1 AND user_id = $2`, [id, userId]);
  return reply.status(204).send();
});

// --- Device group erişim izinleri (role_device_group_permissions'ın yeni sahibi) ---

const SetGroupDevicePermissionSchema = z.object({
  device_group_id: z.string().uuid(),
  permission: z.enum(["read", "read_write", "deny"])
});

app.get("/api/v1/user-groups/:id/device-permissions", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "user_groups", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("user_groups", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Grup bulunamadı" });
  }
  const result = await pool.query(
    `SELECT ugdp.id, ugdp.device_group_id, ugdp.permission, dg.name as device_group_name
     FROM user_group_device_permissions ugdp
     JOIN device_groups dg ON dg.id = ugdp.device_group_id
     WHERE ugdp.user_group_id = $1`,
    [id]
  );
  return result.rows;
});

app.post("/api/v1/user-groups/:id/device-permissions", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "user_groups", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("user_groups", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Grup bulunamadı" });
  }
  const parsed = SetGroupDevicePermissionSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  if (!(await idBelongsToTenant("device_groups", parsed.data.device_group_id, auth.tenantId))) {
    return reply.status(404).send({ error: "Cihaz grubu bulunamadı" });
  }
  const result = await pool.query(
    `INSERT INTO user_group_device_permissions (user_group_id, device_group_id, permission)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_group_id, device_group_id) DO UPDATE SET permission = $3
     RETURNING id, device_group_id, permission`,
    [id, parsed.data.device_group_id, parsed.data.permission]
  );
  return reply.status(201).send(result.rows[0]);
});

app.delete("/api/v1/user-groups/:id/device-permissions/:permissionId", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "user_groups", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id, permissionId } = request.params as { id: string; permissionId: string };
  const ownerCheck = await pool.query(
    `SELECT ugdp.id FROM user_group_device_permissions ugdp
     JOIN user_groups ug ON ug.id = ugdp.user_group_id
     WHERE ugdp.id = $1 AND ugdp.user_group_id = $2 AND ug.tenant_id = $3`,
    [permissionId, id, auth.tenantId]
  );
  if (ownerCheck.rows.length === 0) return reply.status(404).send({ error: "İzin kaydı bulunamadı" });
  await pool.query(`DELETE FROM user_group_device_permissions WHERE id = $1`, [permissionId]);
  return reply.status(204).send();
});

// --- Tag-bazlı alarm/problem filtresi (belirli bir device_group izniyle ilişkili) ---

const SetTagFilterSchema = z.object({
  device_group_id: z.string().uuid(),
  tag: z.string().min(1),
  value: z.string().optional()
});

app.get("/api/v1/user-groups/:id/tag-filters", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "user_groups", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("user_groups", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Grup bulunamadı" });
  }
  const result = await pool.query(
    `SELECT ugtf.id, ugtf.device_group_id, ugtf.tag, ugtf.value, dg.name as device_group_name
     FROM user_group_tag_filters ugtf
     JOIN device_groups dg ON dg.id = ugtf.device_group_id
     WHERE ugtf.user_group_id = $1`,
    [id]
  );
  return result.rows;
});

app.post("/api/v1/user-groups/:id/tag-filters", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "user_groups", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("user_groups", id, auth.tenantId))) {
    return reply.status(404).send({ error: "Grup bulunamadı" });
  }
  const parsed = SetTagFilterSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  if (!(await idBelongsToTenant("device_groups", parsed.data.device_group_id, auth.tenantId))) {
    return reply.status(404).send({ error: "Cihaz grubu bulunamadı" });
  }
  const result = await pool.query(
    `INSERT INTO user_group_tag_filters (user_group_id, device_group_id, tag, value)
     VALUES ($1, $2, $3, $4) RETURNING id, device_group_id, tag, value`,
    [id, parsed.data.device_group_id, parsed.data.tag, parsed.data.value || null]
  );
  return reply.status(201).send(result.rows[0]);
});

app.delete("/api/v1/user-groups/:id/tag-filters/:filterId", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "user_groups", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id, filterId } = request.params as { id: string; filterId: string };
  const ownerCheck = await pool.query(
    `SELECT ugtf.id FROM user_group_tag_filters ugtf
     JOIN user_groups ug ON ug.id = ugtf.user_group_id
     WHERE ugtf.id = $1 AND ugtf.user_group_id = $2 AND ug.tenant_id = $3`,
    [filterId, id, auth.tenantId]
  );
  if (ownerCheck.rows.length === 0) return reply.status(404).send({ error: "Filtre bulunamadı" });
  await pool.query(`DELETE FROM user_group_tag_filters WHERE id = $1`, [filterId]);
  return reply.status(204).send();
});


// ============ LDAP CONFIG (Faz 4) ============
// Tenant başına tek bir LDAP sunucu tanımı. Gerçek bind/authentication
// login endpoint'inde (resolveAuthMethodForUser + authenticateViaLdap) uygulanır.

const UpsertLdapConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().default(389),
  bind_dn: z.string().min(1),
  bind_password: z.string().min(1),
  base_dn: z.string().min(1),
  user_search_filter: z.string().default("(uid=%s)"),
  use_tls: z.boolean().default(true),
  enabled: z.boolean().default(true)
});

app.get("/api/v1/ldap-config", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "user_groups", "read")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const result = await pool.query(
    `SELECT id, host, port, bind_dn, base_dn, user_search_filter, use_tls, enabled
     FROM ldap_configs WHERE tenant_id = $1`,
    [auth.tenantId]
  );
  // GÜVENLİK: bind_password_encrypted (hatta çözülmüş hali) ASLA response'a
  // dahil edilmiyor -- servis hesabı şifresi tek yönlü, sadece login sırasında
  // sunucu içinde çözülüp kullanılıyor.
  return result.rows[0] || null;
});

app.put("/api/v1/ldap-config", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "user_groups", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const parsed = UpsertLdapConfigSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const encryptedPassword = encryptSecret(parsed.data.bind_password);
  const result = await pool.query(
    `INSERT INTO ldap_configs (tenant_id, host, port, bind_dn, bind_password_encrypted, base_dn, user_search_filter, use_tls, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tenant_id) DO UPDATE SET
       host = $2, port = $3, bind_dn = $4, bind_password_encrypted = $5,
       base_dn = $6, user_search_filter = $7, use_tls = $8, enabled = $9
     RETURNING id, host, port, bind_dn, base_dn, user_search_filter, use_tls, enabled`,
    [auth.tenantId, parsed.data.host, parsed.data.port, parsed.data.bind_dn, encryptedPassword,
     parsed.data.base_dn, parsed.data.user_search_filter, parsed.data.use_tls, parsed.data.enabled]
  );
  return result.rows[0];
});

// Servis hesabı bağlantısını gerçek sunucuya bağlanmadan test etmek için --
// kullanıcı adı/şifre olmadan, sadece bind_dn/bind_password ile bağlanabiliyor
// muyuz diye kontrol eder.
app.post("/api/v1/ldap-config/test", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "user_groups", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const result = await pool.query(
    `SELECT host, port, bind_dn, bind_password_encrypted, base_dn, user_search_filter, use_tls
     FROM ldap_configs WHERE tenant_id = $1`,
    [auth.tenantId]
  );
  if (result.rows.length === 0) return reply.status(404).send({ error: "LDAP yapılandırması bulunamadı" });

  const config = result.rows[0];
  const url = `${config.use_tls ? "ldaps" : "ldap"}://${config.host}:${config.port}`;
  const client = ldap.createClient({ url, timeout: 5000, connectTimeout: 5000 });
  try {
    const bindPassword = decryptSecret(config.bind_password_encrypted);
    await new Promise<void>((resolve, reject) => {
      client.bind(config.bind_dn, bindPassword, (err) => (err ? reject(err) : resolve()));
    });
    return { ok: true, message: "Servis hesabı bağlantısı başarılı" };
  } catch (err: any) {
    return reply.status(400).send({ ok: false, error: err?.message || "Bağlantı başarısız" });
  } finally {
    client.unbind();
  }
});

// ============ ESKALASYON POLİTİKALARI (çok adımlı bildirim/otomatik müdahale) ============
// Tasarım kararı (kullanıcıyla konuşulup kararlaştırıldı): eskalasyon
// adımları önceden DOĞRUDAN tek bir alert_template_rule_id'ye bağlıydı --
// Zabbix'in Actions/Operations'ı ya da PagerDuty/Opsgenie'nin Escalation
// Policy'si gibi YENİDEN KULLANILABİLİR değildi (aynı 3 adımlı zinciri her
// kuralda yeniden girmek gerekirdi). Artık bağımsız, adlandırılmış bir
// "politika" (escalation_policies + escalation_policy_steps) -- hem şablon
// kuralları HEM cihaza özel kurallar (alert_rules/alert_template_rules.
// escalation_policy_id) aynı politikayı seçebilir.

const CreateEscalationPolicySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional()
});

app.get("/api/v1/escalation-policies", async (request) => {
  const auth = (request as any).auth;
  const result = await pool.query(
    `SELECT ep.id, ep.name, ep.description, ep.created_at,
            (SELECT COUNT(*)::int FROM escalation_policy_steps eps WHERE eps.policy_id = ep.id) as step_count
     FROM escalation_policies ep WHERE ep.tenant_id = $1 ORDER BY ep.name`,
    [auth.tenantId]
  );
  return result.rows;
});

app.post("/api/v1/escalation-policies", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const parsed = CreateEscalationPolicySchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const result = await pool.query(
    `INSERT INTO escalation_policies (tenant_id, name, description) VALUES ($1, $2, $3)
     RETURNING id, name, description, created_at`,
    [auth.tenantId, parsed.data.name, parsed.data.description || null]
  );
  return reply.status(201).send(result.rows[0]);
});

app.delete("/api/v1/escalation-policies/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  await pool.query(`DELETE FROM escalation_policies WHERE tenant_id = $1 AND id = $2`, [auth.tenantId, id]);
  return reply.status(204).send();
});

const CreateEscalationPolicyStepSchema = z.object({
  step_order: z.number().min(1).default(1),
  delay_seconds: z.number().min(0).default(0),
  action_type: z.enum(["notify", "remote_command"]),
  media_type_id: z.string().uuid().optional(),
  remote_command: z.string().optional()
});

async function escalationPolicyBelongsToTenant(policyId: string, tenantId: string): Promise<boolean> {
  const result = await pool.query(`SELECT id FROM escalation_policies WHERE id = $1 AND tenant_id = $2`, [policyId, tenantId]);
  return result.rows.length > 0;
}

app.get("/api/v1/escalation-policies/:id/steps", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  if (!(await escalationPolicyBelongsToTenant(id, auth.tenantId))) {
    return reply.status(404).send({ error: "Politika bulunamadı" });
  }
  const result = await pool.query(
    `SELECT eps.id, eps.step_order, eps.delay_seconds, eps.action_type, eps.media_type_id, eps.remote_command, mt.name as media_type_name
     FROM escalation_policy_steps eps
     LEFT JOIN media_types mt ON mt.id = eps.media_type_id
     WHERE eps.policy_id = $1 ORDER BY eps.step_order`,
    [id]
  );
  return result.rows;
});

app.post("/api/v1/escalation-policies/:id/steps", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const { id } = request.params as { id: string };
  if (!(await escalationPolicyBelongsToTenant(id, auth.tenantId))) {
    return reply.status(404).send({ error: "Politika bulunamadı" });
  }
  const parsed = CreateEscalationPolicyStepSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { step_order, delay_seconds, action_type, media_type_id, remote_command } = parsed.data;

  if (action_type === "notify" && !media_type_id) {
    return reply.status(400).send({ error: "notify tipi için media_type_id gerekli" });
  }
  if (action_type === "remote_command" && !remote_command) {
    return reply.status(400).send({ error: "remote_command tipi için remote_command gerekli" });
  }

  const result = await pool.query(
    `INSERT INTO escalation_policy_steps (policy_id, step_order, delay_seconds, action_type, media_type_id, remote_command)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, step_order, delay_seconds, action_type, media_type_id, remote_command`,
    [id, step_order, delay_seconds, action_type, media_type_id || null, remote_command || null]
  );
  return reply.status(201).send(result.rows[0]);
});

app.delete("/api/v1/escalation-policy-steps/:id", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "alert_rules", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
  const { id } = request.params as { id: string };
  const ownerCheck = await pool.query(
    `SELECT eps.id FROM escalation_policy_steps eps
     JOIN escalation_policies ep ON ep.id = eps.policy_id
     WHERE eps.id = $1 AND ep.tenant_id = $2`,
    [id, auth.tenantId]
  );
  if (ownerCheck.rows.length === 0) return reply.status(404).send({ error: "Eskalasyon adımı bulunamadı" });
  await pool.query(`DELETE FROM escalation_policy_steps WHERE id = $1`, [id]);
  return reply.status(204).send();
});

// Internal servisler (Alarm Engine) için — bir alert_rule'ın (ister şablondan
// gelsin ister cihaza özel olsun, ikisi de artık AYNI escalation_policy_id
// alanını taşıyor) bağlı olduğu politikanın adımlarını döner. Önceki tasarımda
// bu sorgu template_rule_id ÜZERİNDEN dolaylı bir JOIN'di ve özel kurallar için
// hiç çalışmıyordu -- artık doğrudan ve tek bir yoldan okunuyor.
app.get("/api/v1/internal/alert-rules/:id/escalation-policy", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const { id } = request.params as { id: string };
  const result = await pool.query(
    `SELECT eps.step_order, eps.delay_seconds, eps.action_type, eps.remote_command,
            mt.id as media_type_id, mt.type as media_type, mt.config as media_type_config
     FROM alert_rules ar
     JOIN escalation_policy_steps eps ON eps.policy_id = ar.escalation_policy_id
     LEFT JOIN media_types mt ON mt.id = eps.media_type_id
     WHERE ar.id = $1 ORDER BY eps.step_order`,
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
    `SELECT id, name, is_shared, is_default, owner_user_id, created_at
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
     RETURNING id, name, is_shared, is_default, owner_user_id`,
    [auth.tenantId, auth.userId, parsed.data.name, parsed.data.is_shared]
  );
  return reply.status(201).send(result.rows[0]);
});

// GERİ ALINDI (kullanıcı isteği): panonun paylaşılan "varsayılan bağlamı"
// (default_device_id vb.) kaldırıldı -- bağlam artık her kullanıcının kendi
// tarayıcısında (localStorage, bkz. DashboardPage.tsx) otomatik kalıcı olduğu
// için bu ayrı, elle tetiklenen "Varsayılan yap" mekanizmasının artık bir
// anlamı kalmadı (zaten hiçbir widget tarafından da okunmuyordu).
const UpdateDashboardSchema = z.object({
  name: z.string().min(1).optional(),
  is_shared: z.boolean().optional()
});

app.patch("/api/v1/dashboards/:id", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  const parsed = UpdateDashboardSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { name, is_shared } = parsed.data;

  const result = await pool.query(
    `UPDATE dashboards SET
       name = COALESCE($3, name),
       is_shared = COALESCE($4, is_shared)
     WHERE id = $1 AND tenant_id = $2 AND owner_user_id = $5
     RETURNING id, name, is_shared, is_default, owner_user_id`,
    [id, auth.tenantId, name, is_shared, auth.userId]
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

// GERÇEK HATA (canlı testte bulundu): widget tipi listesi burada, BulkWidgetSchema'da
// ve infra/sql'deki dashboard_widgets_widget_type_check CHECK constraint'inde AYRI AYRI
// tutuluyordu -- yeni bir widget tipi eklerken (predictive_forecast/alert_trend) DB
// constraint'i ve frontend'i güncelleyip bu ikisinden birini (BulkWidgetSchema)
// GÜNCELLEMEYİ UNUTMAK kolaydı, "Kaydedilemedi" hatasıyla sonuçlandı. Artık TEK bir
// dizi -- ikisi de buradan türüyor, gelecekte SADECE burası güncellenmesi yeterli
// (DB constraint'i ayrı kalıyor çünkü migration'lar geriye dönük değiştirilemez).
const WIDGET_TYPES = [
  "graph", "problem_list", "device_status", "kpi_card",
  "severity_distribution", "problem_devices", "top_n", "platform_summary",
  "service_health", "escalation_history", "maintenance_windows",
  "device_card", "status_badge", "raw_table", "note", "clock", "url", "gauge", "pie_chart",
  "device_explorer", "status_grid", "web_monitoring_summary", "host_performance_table",
  "vmware_cluster_summary", "vmware_datastore", "vmware_vm_table", "trap_log", "syslog_log",
  "predictive_forecast", "alert_trend", "geomap"
] as const;

const CreateWidgetSchema = z.object({
  widget_type: z.enum(WIDGET_TYPES),
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
  // GERÇEK EKSİKLİK (widget ayarları her zaman görünür/düzenlenebilir hale
  // getirilirken bulundu): title=null (kullanıcı özel başlığı temizleyip
  // varsayılana dönmek istediğinde) COALESCE($6, dw.title) tarafından "hiç
  // gönderilmemiş" ile AYNI muamele görüyordu -- title'ı temizlemek SESSİZCE
  // hiçbir şey yapmıyordu. schedule_interval_hours PATCH'indeki (discovery_rules)
  // AYNI tri-state çözümü: ayrı bir "gönderildi mi" bayrağı.
  const titleWasSent = title !== undefined;

  const result = await pool.query(
    `UPDATE dashboard_widgets AS dw SET
       position_x = COALESCE($2, dw.position_x),
       position_y = COALESCE($3, dw.position_y),
       width = COALESCE($4, dw.width),
       height = COALESCE($5, dw.height),
       title = CASE WHEN $6 THEN $7 ELSE dw.title END,
       config = COALESCE($8, dw.config)
     FROM dashboards d
     WHERE dw.id = $1 AND dw.dashboard_id = d.id AND d.tenant_id = $9 AND d.owner_user_id = $10
     RETURNING dw.id, dw.widget_type, dw.position_x, dw.position_y, dw.width, dw.height, dw.title, dw.config`,
    [id, position_x, position_y, width, height, titleWasSent, title ?? null, config ? JSON.stringify(config) : null, auth.tenantId, auth.userId]
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
  widget_type: z.enum(WIDGET_TYPES),
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

// Kapasite Tahmini -- Tahminsel Analiz'in (predictiveAnalytics.ts) açtığı
// is_predictive alarmlarını "eşiğe kalan süreye" göre en yakından en uzağa
// sıralar (Zabbix/Datadog'daki "capacity forecast" panelleriyle AYNI fikir).
app.get("/api/v1/dashboard-widgets-data/predictive-forecast", async (request) => {
  const auth = (request as any).auth;
  const query = request.query as { device_group_id?: string; limit?: string };
  const limit = Math.min(Number(query.limit) || 10, 50);

  let sql = `
    SELECT a.id, a.device_id, d.name as device_name, a.metric_name, a.severity, a.message,
           a.predicted_hours_to_breach, a.triggered_at
    FROM alerts a
    JOIN devices d ON d.id = a.device_id
    WHERE a.tenant_id = $1 AND a.is_predictive = true AND a.resolved_at IS NULL
      AND a.predicted_hours_to_breach IS NOT NULL`;
  const params: any[] = [auth.tenantId];

  if (query.device_group_id) {
    sql += ` AND a.device_id IN (SELECT device_id FROM device_group_members WHERE device_group_id = $2)`;
    params.push(query.device_group_id);
  }
  sql += ` ORDER BY a.predicted_hours_to_breach ASC LIMIT ${limit}`;

  const result = await pool.query(sql, params);
  return result.rows;
});

// Alarm Trend -- severity başına, zaman içinde YENİ TETİKLENEN alarm sayısı
// (Zabbix'in "Problems by severity" zaman-serisi grafiği / Grafana-Datadog'un
// "alerts fired over time" panelleriyle AYNI fikir -- severity_distribution
// widget'ı SADECE anlık durumu gösteriyor, bu TRENDİ gösteriyor). hours<=48 ise
// saatlik, daha büyükse günlük bucket'lara ayrılır (çok fazla bar olmasın diye).
app.get("/api/v1/dashboard-widgets-data/alert-trend", async (request) => {
  const auth = (request as any).auth;
  const query = request.query as { device_group_id?: string; hours?: string };
  const hours = Math.min(Math.max(Number(query.hours) || 24, 1), 720);
  const bucketUnit = hours <= 48 ? "hour" : "day";

  let sql = `
    SELECT date_trunc('${bucketUnit}', a.triggered_at) as bucket, a.severity, COUNT(*)::int as count
    FROM alerts a
    WHERE a.tenant_id = $1 AND a.triggered_at >= now() - ($2 || ' hours')::interval`;
  const params: any[] = [auth.tenantId, hours];

  if (query.device_group_id) {
    sql += ` AND a.device_id IN (SELECT device_id FROM device_group_members WHERE device_group_id = $3)`;
    params.push(query.device_group_id);
  }
  sql += ` GROUP BY bucket, a.severity ORDER BY bucket ASC`;

  const result = await pool.query(sql, params);
  return result.rows;
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
    let windows: { avg_5m: number | null; avg_15m: number | null; avg_1h: number | null } | null = null;

    for (let i = 0; i < metricNames.length; i++) {
      const metricName = metricNames[i];
      const rowsResult = await pool.query(
        `SELECT time, value FROM metrics WHERE tenant_id = $1 AND device_id = $2 AND metric_name = $3
         ORDER BY time DESC LIMIT $4`,
        [auth.tenantId, device.id, metricName, points]
      );
      const rows = rowsResult.rows.reverse();
      series[metricName] = rows;
      latest[metricName] = rows.length > 0 ? Number(rows[rows.length - 1].value) : null;

      // Kullanıcı isteği: Zabbix'in "Top hosts" widget'ındaki 1m/5m/15m ortalama
      // sütunlarıyla AYNI fikir -- ama agent'ımızın ~60sn'lik gönderim aralığına
      // (services/agent/config.go MetricsSeconds varsayılanı) uygun pencerelerle:
      // "1dk ortalaması" bizde fiilen tek bir örneğin kendisi olurdu (anlamsız),
      // bu yüzden 5dk/15dk/1sa kullanılıyor. SADECE ana (ilk) metrik için --
      // her metrik için 3 sütun eklemek tabloyu pratik olmayacak kadar genişletirdi.
      if (i === 0) {
        const windowResult = await pool.query(
          `SELECT
             AVG(value) FILTER (WHERE time >= now() - interval '5 minutes') as avg_5m,
             AVG(value) FILTER (WHERE time >= now() - interval '15 minutes') as avg_15m,
             AVG(value) FILTER (WHERE time >= now() - interval '1 hour') as avg_1h
           FROM metrics WHERE tenant_id = $1 AND device_id = $2 AND metric_name = $3 AND time >= now() - interval '1 hour'`,
          [auth.tenantId, device.id, metricName]
        );
        const w = windowResult.rows[0];
        windows = {
          avg_5m: w.avg_5m !== null ? Number(w.avg_5m) : null,
          avg_15m: w.avg_15m !== null ? Number(w.avg_15m) : null,
          avg_1h: w.avg_1h !== null ? Number(w.avg_1h) : null
        };
      }
    }
    results.push({ device_id: device.id, device_name: device.name, series, latest, windows });
  }
  return results;
});

// FAZ J — VMware widget'ları için genel amaçlı endpoint: TEK bir cihazın (örn. bir
// vCenter) verilen metrik adları için TÜM instance_label değerlerini (cluster'lar,
// datastore'lar -- bunlar host hiyerarşi düzeltmesinden SONRA bile hâlâ vCenter'ın
// KENDİ device_id'sinde kalıyor) en son değerleriyle döndürür.
app.get("/api/v1/dashboard-widgets-data/vmware-instance-summary", async (request, reply) => {
  const auth = (request as any).auth;
  const query = request.query as { device_id?: string; metrics?: string };
  if (!query.device_id || !query.metrics) return reply.status(400).send({ error: "device_id ve metrics gerekli" });
  if (!(await idBelongsToTenant("devices", query.device_id, auth.tenantId))) return reply.status(404).send({ error: "Cihaz bulunamadı" });

  const metricNames = query.metrics.split(",").map((m) => m.trim()).filter(Boolean).slice(0, 10);

  // DISTINCT ON (instance_label, metric_name): her instance+metrik kombinasyonu için
  // SADECE en son satırı al -- TimescaleDB'nin zaman-sıralı yapısı sayesinde
  // ORDER BY time DESC ile ucuz bir sorgu.
  const result = await pool.query(
    `SELECT DISTINCT ON (instance_label, metric_name) instance_label, metric_name, value, time
     FROM metrics
     WHERE tenant_id = $1 AND device_id = $2 AND metric_name = ANY($3::text[]) AND instance_label IS NOT NULL
     ORDER BY instance_label, metric_name, time DESC`,
    [auth.tenantId, query.device_id, metricNames]
  );

  // Satırları instance_label bazında grupla: [{ instance_label, values: { metric_name: value } }]
  const grouped = new Map<string, Record<string, number>>();
  for (const row of result.rows) {
    if (!grouped.has(row.instance_label)) grouped.set(row.instance_label, {});
    grouped.get(row.instance_label)![row.metric_name] = Number(row.value);
  }
  return Array.from(grouped.entries()).map(([instance_label, values]) => ({ instance_label, values }));
});

// FAZ J — VM Kaynak Kullanımı widget'ı için: bir device_group'taki (örn. bir vCenter'ın
// "Tüm Host'lar" grubu) TÜM cihazların VM-bazlı instance_label metriklerini TOPLAR --
// host hiyerarşi düzeltmesinden SONRA VM metrikleri artık vCenter'ın DEĞİL, ÇALIŞTIKLARI
// HOST'un device_id'sinde olduğu için, "bu vCenter'ın tüm VM'leri" sorgusu TEK bir
// cihaz değil, o vCenter'a ait TÜM host cihazlarını (device_group üzerinden) kapsamalı.
app.get("/api/v1/dashboard-widgets-data/vmware-vm-table", async (request, reply) => {
  const auth = (request as any).auth;
  const query = request.query as { device_group_id?: string; metrics?: string };
  if (!query.device_group_id || !query.metrics) return reply.status(400).send({ error: "device_group_id ve metrics gerekli" });
  if (!(await idBelongsToTenant("device_groups", query.device_group_id, auth.tenantId))) return reply.status(404).send({ error: "Cihaz grubu bulunamadı" });

  const metricNames = query.metrics.split(",").map((m) => m.trim()).filter(Boolean).slice(0, 10);

  const result = await pool.query(
    `SELECT DISTINCT ON (m.device_id, m.instance_label, m.metric_name)
            m.device_id, d.name as device_name, m.instance_label, m.metric_name, m.value, m.time
     FROM metrics m
     JOIN devices d ON d.id = m.device_id
     WHERE m.tenant_id = $1
       AND m.device_id IN (SELECT device_id FROM device_group_members WHERE device_group_id = $2)
       AND m.metric_name = ANY($3::text[]) AND m.instance_label IS NOT NULL
     ORDER BY m.device_id, m.instance_label, m.metric_name, m.time DESC
     LIMIT 2000`,
    [auth.tenantId, query.device_group_id, metricNames]
  );

  const grouped = new Map<string, { device_id: string; device_name: string; instance_label: string; values: Record<string, number> }>();
  for (const row of result.rows) {
    const key = `${row.device_id}::${row.instance_label}`;
    if (!grouped.has(key)) grouped.set(key, { device_id: row.device_id, device_name: row.device_name, instance_label: row.instance_label, values: {} });
    grouped.get(key)!.values[row.metric_name] = Number(row.value);
  }
  return Array.from(grouped.values());
});


// alerts.last_escalation_step değişimini doğrudan gösteremediğimiz için basitleştirilmiş:
// son güncellenen (last_escalation_step > 0) alarmları listeler)
// SNMP Trap Log widget'ı -- kullanıcı isteği (Trap Log görünümü). trapReceiver.ts
// tarafından yayınlanan 'snmp_trap' metriklerini (instance_label=trap türü) zaman
// sırasıyla listeler. Ham trap OID'i KALICI OLARAK SAKLANMIYOR (metrics tablosunda
// genel bir tags/jsonb kolonu yok, sadece instance_label çıkarılıp tutuluyor) --
// trap TÜRÜ (örn. 'linkDown') zaten en önemli bilgi olduğu için bu kabul edilebilir
// bir sınırlama.
app.get("/api/v1/dashboard-widgets-data/trap-log", async (request) => {
  const auth = (request as any).auth;
  const query = request.query as { limit?: string; device_group_id?: string };
  const limit = Math.min(Number(query.limit) || 20, 100);

  const conditions = ["m.tenant_id = $1", "m.metric_name = 'snmp_trap'"];
  const params: any[] = [auth.tenantId];
  let paramIndex = 2;
  if (query.device_group_id) {
    conditions.push(`m.device_id IN (SELECT device_id FROM device_group_members WHERE device_group_id = $${paramIndex})`);
    params.push(query.device_group_id);
    paramIndex++;
  }

  const result = await pool.query(
    `SELECT m.time, m.instance_label as trap_type, d.id as device_id, d.name as device_name
     FROM metrics m
     JOIN devices d ON d.id = m.device_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY m.time DESC LIMIT ${limit}`,
    params
  );
  return result.rows;
});

// Syslog Log widget'ı -- syslogReceiver.ts'in syslog_messages tablosuna yazdığı ham
// mesajları zaman sırasıyla listeler. Trap Log'dan farkı: burada asıl değer serbest-metin
// MESAJIN kendisidir (severity/appname/hostname ile birlikte), sadece bir tür/etiket değil.
// Opsiyonel min_severity filtresi: örn. min_severity=4 => warning ve daha ciddi (severity<=4).
app.get("/api/v1/dashboard-widgets-data/syslog-log", async (request) => {
  const auth = (request as any).auth;
  const query = request.query as { limit?: string; device_group_id?: string; min_severity?: string };
  const limit = Math.min(Number(query.limit) || 20, 200);

  const conditions = ["s.tenant_id = $1"];
  const params: any[] = [auth.tenantId];
  let paramIndex = 2;
  if (query.device_group_id) {
    conditions.push(`s.device_id IN (SELECT device_id FROM device_group_members WHERE device_group_id = $${paramIndex})`);
    params.push(query.device_group_id);
    paramIndex++;
  }
  if (query.min_severity !== undefined && query.min_severity !== "") {
    conditions.push(`s.severity <= $${paramIndex}`);
    params.push(Number(query.min_severity));
    paramIndex++;
  }

  const result = await pool.query(
    `SELECT s.time, s.severity, s.severity_name, s.facility, s.hostname, s.appname, s.message,
            d.id as device_id, d.name as device_name
     FROM syslog_messages s
     JOIN devices d ON d.id = s.device_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY s.time DESC LIMIT ${limit}`,
    params
  );
  return result.rows;
});

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
    `SELECT id, name, ip_address, device_type, vendor, status, attributes FROM devices WHERE id = $1 AND tenant_id = $2`,
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

  // TÜM İLİŞKİLER (kullanıcı isteği): bu cihaz bir VMware host'uysa (attributes.
  // vmware_host_id dolu), üzerinde çalışan VM'lerin listesini de döndür -- VM'ler
  // kendi başına bir devices satırı DEĞİL (sadece host'un instance_label'lı bir
  // metriği), bu yüzden topoloji grafiğinde ayrı düğüm olarak GÖSTERİLEMEZ, ama
  // host'a tıklandığında yan panelde İLİŞKİLİ VM listesi olarak gösterilebilir.
  let vms: Array<{ name: string; power_state: number }> = [];
  if (deviceResult.rows[0].attributes?.vmware_host_id) {
    const vmResult = await pool.query(
      `SELECT DISTINCT ON (instance_label) instance_label, value
       FROM metrics
       WHERE device_id = $1 AND metric_name = 'vmware_vm_power_state'
       ORDER BY instance_label, time DESC`,
      [deviceId]
    );
    vms = vmResult.rows.map((r) => ({ name: r.instance_label, power_state: Number(r.value) }));
  }

  return { ...deviceResult.rows[0], open_alert_count: alertResult.rows[0].c, templates: templateResult.rows.map((r) => r.name), vms };
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

  // if_oper_status gibi template_item'a bağlı olmayan baseline metrikler için
  // metric_value_maps yedeği (bkz. /api/v1/metrics/names'teki aynı mantık).
  let mappings: Array<{ value: string; label: string }> | null = itemResult.rows[0]?.mappings ?? null;
  if (!mappings) {
    const fallbackResult = await pool.query(
      `SELECT vm.mappings FROM metric_value_maps mvm
       JOIN value_maps vm ON vm.id = mvm.value_map_id
       WHERE mvm.tenant_id = $1 AND mvm.metric_name = $2 LIMIT 1`,
      [auth.tenantId, query.metric_name]
    );
    mappings = fallbackResult.rows[0]?.mappings ?? null;
  }
  if (!mappings) {
    const statusSuffixIds = await getStatusSuffixValueMapIds(auth.tenantId);
    const suffixValueMapId = resolveStatusSuffixValueMapId(query.metric_name, statusSuffixIds);
    if (suffixValueMapId) {
      const suffixResult = await pool.query(`SELECT mappings FROM value_maps WHERE id = $1`, [suffixValueMapId]);
      mappings = suffixResult.rows[0]?.mappings ?? null;
    }
  }

  const rawValue = metricResult.rows[0].value;
  let label = String(rawValue);
  if (mappings) {
    const mapping = mappings.find((m: any) => m.value === String(rawValue));
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
    `SELECT id, device_a_id, device_b_id, interface_a, interface_b, discovery_method FROM device_links WHERE tenant_id = $1`,
    [auth.tenantId]
  );

  // TÜM İLİŞKİLER (kullanıcı isteği): device_links (manuel bağlantılar) DIŞINDA,
  // device_group üyeliklerini de (özellikle VMware'in otomatik senkronize ettiği
  // "Tüm Host'lar"/"Cluster: X" grupları) döndürüyoruz -- frontend bunları görsel
  // kümeleme (host'ları kendi cluster'ının çerçevesi içinde gruplama) için kullanır.
  // Sadece BİRDEN FAZLA üyesi olan grupları döndürüyoruz (tek üyeli/boş gruplar
  // görsel kümeleme açısından anlamsız).
  const groupsResult = await pool.query(
    `SELECT g.id, g.name, (g.vmware_source_device_id IS NOT NULL) as is_vmware_managed,
            COALESCE(json_agg(m.device_id) FILTER (WHERE m.device_id IS NOT NULL), '[]') as member_device_ids
     FROM device_groups g
     JOIN device_group_members m ON m.device_group_id = g.id
     WHERE g.tenant_id = $1
     GROUP BY g.id
     HAVING COUNT(m.device_id) > 1`,
    [auth.tenantId]
  );

  // TÜM İLİŞKİLER (kullanıcı isteği): vCenter/ESXi cihazından, senkronize ettiği
  // host'lara doğru GÖRSEL hiyerarşi bağlantıları -- device_links (manuel, kullanıcı
  // tanımlı fiziksel bağlantılar) İLE AYNI ŞEY DEĞİL, bu yüzden AYRI bir liste olarak
  // dönüyor (frontend farklı bir stille -- kesikli, ince -- çizecek).
  const hierarchyLinksResult = await pool.query(
    `SELECT DISTINCT dg.vmware_source_device_id as source_device_id, m.device_id as target_device_id
     FROM device_groups dg
     JOIN device_group_members m ON m.device_group_id = dg.id
     WHERE dg.tenant_id = $1 AND dg.vmware_source_device_id IS NOT NULL`,
    [auth.tenantId]
  );

  // TÜM İLİŞKİLER (kullanıcı isteği): trafik-bazlı otomatik bağlantılar --
  // ESKİDEN sadece /api/v1/topology (hours parametreli, kullanılmayan) endpoint'inde
  // vardı, TopologyGraph HİÇ ÇAĞIRMIYORDU. Aynı mantık buraya taşındı -- flows
  // tablosundaki (NetFlow/sFlow) src_ip/dst_ip'yi devices.ip_address ile eşleştirip,
  // HER İKİ ucu da izlediğimiz bir cihaz olan trafiği (dış internet trafiği gürültü
  // yaratır, hariç tutuluyor) topoloji kenarı olarak döndürüyoruz. Son 24 saat sabit
  // (topology/full'da hours parametresi yok, gelecekte eklenebilir).
  let trafficEdges: Array<{ device_a_id: string; device_b_id: string; total_bytes: number }> = [];
  try {
    const ipToDeviceId: Record<string, string> = {};
    for (const d of devicesResult.rows) if (d.ip_address) ipToDeviceId[d.ip_address] = d.id;

    const flowRows = await queryClickHouse(`
      SELECT src_ip, dst_ip, sum(bytes * sampling_rate) AS total_bytes
      FROM flows
      WHERE tenant_id = '${auth.tenantId}' AND timestamp >= now() - INTERVAL 24 HOUR
      GROUP BY src_ip, dst_ip
    `);
    for (const row of flowRows as any[]) {
      const srcDeviceId = ipToDeviceId[row.src_ip];
      const dstDeviceId = ipToDeviceId[row.dst_ip];
      if (srcDeviceId && dstDeviceId && srcDeviceId !== dstDeviceId) {
        trafficEdges.push({ device_a_id: srcDeviceId, device_b_id: dstDeviceId, total_bytes: Number(row.total_bytes) });
      }
    }
  } catch (err) {
    request.log.warn("Topoloji trafik sorgusu başarısız (ClickHouse boş olabilir): " + err);
  }

  return { devices: devicesResult.rows, links: linksResult.rows, groups: groupsResult.rows, hierarchyLinks: hierarchyLinksResult.rows, trafficEdges };
});

const SaveTopologyPositionsSchema = z.object({
  positions: z.array(z.object({ device_id: z.string().uuid(), x: z.number(), y: z.number() }))
});

app.put("/api/v1/topology/positions", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

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
  interface_type: z.enum(["snmp", "ssh", "sql", "web", "vmware"]),
  ip_address: z.string().optional(),
  port: z.number().optional(),
  snmp_community: z.string().optional(),
  vmware_mode: z.enum(["vcenter", "esxi"]).optional(),
  tls_skip_verify: z.boolean().optional()
});

app.get("/api/v1/devices/:id/interfaces", async (request, reply) => {
  const auth = (request as any).auth;
  const { id } = request.params as { id: string };
  if (!(await idBelongsToTenant("devices", id, auth.tenantId))) return reply.status(404).send({ error: "Cihaz bulunamadı" });

  const result = await pool.query(
    `SELECT id, interface_type, ip_address, port, snmp_community, vmware_mode, tls_skip_verify FROM device_interfaces WHERE device_id = $1`,
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
        `INSERT INTO device_interfaces (device_id, interface_type, ip_address, port, snmp_community, vmware_mode, tls_skip_verify) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, iface.interface_type, iface.ip_address, iface.port || null, iface.snmp_community || null, iface.vmware_mode || null, iface.tls_skip_verify ?? false]
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
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

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
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
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
// GÜVENLİK DÜZELTMESİ: önceden GET + query string (?device_id=&psk=) kullanılıyordu --
// PSK gibi bir secret'ın query string'de taşınması, erişim loglarına/reverse proxy
// loglarına/Referer header'larına sızabilir. heartbeat ve metrics endpoint'leriyle
// TUTARLI olacak şekilde POST + body'ye çevrildi (agent tarafı da güncellendi, bkz.
// services/agent/itemsync.go). Eski (GET) agent binary'leri bu değişiklikten sonra
// 404 alır -- agent'ların yeniden derlenip dağıtılması gerekir.
app.post("/api/v1/agent/items", async (request, reply) => {
  const { device_id, psk } = request.body as { device_id?: string; psk?: string };
  if (!device_id || !psk || !(await authenticateAgent(device_id, psk))) {
    return reply.status(401).send({ error: "Geçersiz cihaz kimliği veya PSK" });
  }

  // item_group NULL ise her zaman toplanır ("core"). Doluysa (örn. Windows
  // servisleri gibi opsiyonel bir alt-grup), o grup dt.enabled_groups
  // dizisinde AÇIKÇA listelenmediği sürece bu item hiç dönülmez -- varsayılan
  // kapalı, cihaz bazında isteğe bağlı açılır (bkz. 105_template_library_cleanup.sql).
  const result = await pool.query(
    `SELECT ti.metric_name, ti.connection_config, ti.is_table, ti.discovery_filter_regex
     FROM template_items ti
     JOIN device_templates dt ON dt.template_id = ti.template_id
     WHERE dt.device_id = $1 AND ti.collector_type = 'agent'
       AND (ti.item_group IS NULL OR ti.item_group = ANY(dt.enabled_groups))`,
    [device_id]
  );
  return result.rows;
});

// Faz G: agent'in Docker/PostgreSQL/Redis plugin'lerinin baglanti bilgisini (endpoint/
// uri/adres) merkezi olarak sunar -- item senkronizasyonuyla (agent/items) AYNI PSK
// deseninde. Agent, kendi RefreshItemsSeconds dongusunde bunu da periyodik cekip
// initPlugins()'i gerekirse yeniden calistiracak (bkz. main.go degisikligi).
// GÜVENLİK DÜZELTMESİ: agent/items ile aynı gerekçeyle POST + body'ye çevrildi.
app.post("/api/v1/agent/plugin-config", async (request, reply) => {
  const { device_id, psk } = request.body as { device_id?: string; psk?: string };
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
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
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
  const { device_id, psk, heartbeat_seconds } = request.body as { device_id?: string; psk?: string; heartbeat_seconds?: number };
  if (!device_id || !psk || !(await authenticateAgent(device_id, psk))) {
    return reply.status(401).send({ error: "Geçersiz cihaz kimliği veya PSK" });
  }

  // GERÇEK EKSİKLİK DÜZELTMESİ (alarm sistemi incelemesi): agent kendi
  // yapılandırılmış heartbeat aralığını (config.go HeartbeatSeconds) artık
  // her heartbeat'te bildiriyor -- alarm-engine'in checkAgentHeartbeats'i
  // SABİT bir varsayım yerine bu GERÇEK değeri kullanabilsin diye.
  if (typeof heartbeat_seconds === "number" && heartbeat_seconds > 0) {
    await pool.query(`UPDATE devices SET last_heartbeat_at = now(), agent_heartbeat_seconds = $2 WHERE id = $1`, [device_id, Math.round(heartbeat_seconds)]);
  } else {
    await pool.query(`UPDATE devices SET last_heartbeat_at = now() WHERE id = $1`, [device_id]);
  }

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
  metrics: z.array(z.object({
    metric_name: z.string(), value: z.number(), unit: z.string().optional(), interface: z.string().optional(),
    tags: z.record(z.string()).optional()
  }))
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
      unit: metric.unit, interface: metric.interface, tags: metric.tags
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
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });
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

// GÜVENLİK DÜZELTMESİ: file_path önceden SADECE var olup olmadığı kontrol edilip
// doğrudan kaydediliyordu -- bu dosya, hiçbir kimlik doğrulaması olmayan
// /api/v1/agent/download endpoint'i üzerinden HERKESE servis edilir. canEditDevices
// yetkisi olan (ama art niyetli/ele geçirilmiş) bir hesap, sunucudaki keyfi bir dosyayı
// (örn. .env, SSH anahtarı) "release" olarak kaydedip parolasız indirtebilirdi. Artık
// file_path, önceden tanımlı bir dizinin (AGENT_RELEASES_DIR) DIŞINA çıkamaz.
const AGENT_RELEASES_DIR = process.env.AGENT_RELEASES_DIR || "/var/lib/iot-observability/agent-releases";

app.post("/api/v1/agent-releases", async (request, reply) => {
  const auth = (request as any).auth;
  if (!hasPermission(auth, "devices", "read_write")) return reply.status(403).send({ error: "Bu işlem için yetkiniz yok" });

  const parsed = PublishReleaseSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

  const path = await import("path");
  const resolvedBase = path.resolve(AGENT_RELEASES_DIR);
  const resolvedPath = path.resolve(resolvedBase, parsed.data.file_path);
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(resolvedBase + path.sep)) {
    return reply.status(400).send({ error: `file_path, ${resolvedBase} dizini içinde olmalı` });
  }

  const fs = await import("fs");
  if (!fs.existsSync(resolvedPath)) return reply.status(400).send({ error: "Belirtilen dosya yolu sunucuda bulunamadı" });

  const fileBuffer = fs.readFileSync(resolvedPath);
  const checksum = crypto.createHash("sha256").update(fileBuffer).digest("hex");

  const result = await pool.query(
    `INSERT INTO agent_releases (version, platform, file_path, sha256_checksum) VALUES ($1, $2, $3, $4)
     ON CONFLICT (platform, version) DO UPDATE SET file_path = $3, sha256_checksum = $4
     RETURNING id, version, platform, sha256_checksum`,
    [parsed.data.version, parsed.data.platform, resolvedPath, checksum]
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
// Performans: her toplanan item icin AYRI bir HTTP istegi yerine, TEK bir istekte
// N kaydi birden gunceller (PostgreSQL'in unnest() fonksiyonuyla). Item sayisi
// buyudukce (yuzlerce/binlerce), bu round-trip sayisini onemli olcude azaltir.
// mark-collected (tekil) HALA duruyor -- exec/sql/web-collector henuz bunu
// kullanmiyor, ileride ayni desene gecirilebilirler.
const MarkCollectedBatchSchema = z.object({
  entries: z.array(z.object({
    device_id: z.string().uuid(),
    resource_type: z.string(),
    resource_id: z.string().uuid(),
    duration_ms: z.number().optional(),
    error: z.string().optional()
  })).min(1).max(1000)
});
app.post("/api/v1/internal/schedule/mark-collected-batch", async (request, reply) => {
  const auth = (request as any).auth;
  if (!auth.isInternalService) return reply.status(403).send({ error: "Bu endpoint sadece internal servisler içindir" });

  const parsed = MarkCollectedBatchSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const { entries } = parsed.data;

  await pool.query(
    `UPDATE item_schedule_state s
     SET next_due_at = now() + (s.polling_interval_seconds || ' seconds')::interval,
         last_collected_at = now(), last_duration_ms = e.duration_ms, last_error = e.error
     FROM (
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::int[], $5::text[])
         AS t(device_id, resource_type, resource_id, duration_ms, error)
     ) e
     WHERE s.device_id = e.device_id AND s.resource_type = e.resource_type AND s.resource_id = e.resource_id`,
    [
      entries.map((e) => e.device_id),
      entries.map((e) => e.resource_type),
      entries.map((e) => e.resource_id),
      entries.map((e) => e.duration_ms ?? null),
      entries.map((e) => e.error ?? null)
    ]
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
  // GERÇEK EKSİKLİK DÜZELTMESİ (alarm sistemi incelemesi): önceden TÜM agent'lar
  // için beklenen aralık sabit 10sn kabul ediliyordu -- her agent kendi
  // agent_heartbeat_seconds'ını (migration 099, artık heartbeat isteğiyle
  // bildiriliyor) taşıdığı için, farklı yapılandırılmış bir agent (örn. 60sn)
  // burada SÜREKLİ "geç kalıyor" gibi görünürdü. "Gecikme" artık her cihazın
  // KENDİ beklenen sıradaki zamanına göre (item_schedule_state'in next_due_at
  // deseniyle AYNI fikir) hesaplanıyor, mutlak bucket sınırları (5sn/10sn/30sn/
  // 1dk/5dk) ise değişmedi.
  const agentResult = await pool.query(
    `WITH agent_lateness AS (
       SELECT CASE WHEN last_heartbeat_at IS NULL THEN NULL
                   ELSE GREATEST(now() - last_heartbeat_at - (agent_heartbeat_seconds || ' seconds')::interval, interval '0')
              END AS lateness
       FROM devices WHERE tenant_id = $1 AND agent_psk IS NOT NULL
     )
     SELECT
       COUNT(*) FILTER (WHERE lateness IS NOT NULL AND lateness <= interval '0 seconds')::int as not_due,
       COUNT(*) FILTER (WHERE lateness > interval '0 seconds' AND lateness <= interval '5 seconds')::int as bucket_5s,
       COUNT(*) FILTER (WHERE lateness > interval '5 seconds' AND lateness <= interval '10 seconds')::int as bucket_10s,
       COUNT(*) FILTER (WHERE lateness > interval '10 seconds' AND lateness <= interval '30 seconds')::int as bucket_30s,
       COUNT(*) FILTER (WHERE lateness > interval '30 seconds' AND lateness <= interval '1 minute')::int as bucket_1m,
       COUNT(*) FILTER (WHERE lateness > interval '1 minute' AND lateness <= interval '5 minutes')::int as bucket_5m,
       COUNT(*) FILTER (WHERE lateness > interval '5 minutes')::int as bucket_over_5m,
       COUNT(*)::int as total
     FROM agent_lateness`,
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

// Zamanlanmış Ağ Keşfi -- schedule_interval_hours dolu ve süresi gelmiş kuralları
// periyodik olarak tetikler. alarm-engine/npm-service'teki safeRun deseniyle AYNI
// mantık: hata bir sonraki turu etkilemesin, process asla çökmesin.
const DISCOVERY_SCHEDULER_INTERVAL_MS = Number(process.env.DISCOVERY_SCHEDULER_INTERVAL_MS) || 5 * 60 * 1000;
async function runDueDiscoveryRules() {
  const due = await pool.query(
    `SELECT * FROM discovery_rules
     WHERE active = true AND schedule_interval_hours IS NOT NULL
       AND (last_run_at IS NULL OR last_run_at <= now() - (schedule_interval_hours || ' hours')::interval)`
  );
  for (const rule of due.rows) {
    const result = await runDiscoveryRule(rule);
    if ("error" in result) {
      console.error(`[Discovery] Zamanlanmış tarama başarısız (rule=${rule.id}):`, result.error);
    } else {
      console.log(`[Discovery] Zamanlanmış tarama başlatıldı (rule=${rule.id}, job=${result.jobId})`);
    }
  }
}
setInterval(() => {
  runDueDiscoveryRules().catch((err) => {
    console.error("[Discovery] Zamanlayıcı turu sırasında yakalanmamış hata (bir sonraki tur devam edecek):", err);
  });
}, DISCOVERY_SCHEDULER_INTERVAL_MS);

const port = Number(process.env.PORT) || 3000;
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
