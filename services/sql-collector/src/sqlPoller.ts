import pg from "pg";
import mysql from "mysql2/promise";
import { MongoClient } from "mongodb";
import { publishMetric } from "./redisClient.js";
import { fetchResolvedConfig, reportCollectorStatus } from "./coreClient.js";
import type { DeviceRow, EffectiveItem } from "./coreClient.js";

async function runPostgresQuery(host: string, port: number, database: string, username: string, password: string, query: string): Promise<number | null> {
  const client = new pg.Client({ host, port, database, user: username, password, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const result = await client.query(query);
    const firstRow = result.rows[0];
    if (!firstRow) return null;
    return Number(Object.values(firstRow)[0]);
  } finally {
    await client.end().catch(() => {});
  }
}

async function runMysqlQuery(host: string, port: number, database: string, username: string, password: string, query: string): Promise<number | null> {
  const connection = await mysql.createConnection({ host, port, database, user: username, password, connectTimeout: 5000 });
  try {
    const [rows] = await connection.query(query);
    const firstRow = (rows as any[])[0];
    if (!firstRow) return null;
    return Number(Object.values(firstRow)[0]);
  } finally {
    await connection.end().catch(() => {});
  }
}

// ============ MONGODB (fan-out) ============
// SQL desenindeki "bir sorgu -> tek metrik" yerine, tek bağlantıyla serverStatus'u
// çekip METRİK BAŞINA bir item'a değer dağıtır. Kimlik bilgileri sürücü tarafından
// SABİT makrolarla ({$MONGO_*}) çözülür -- item'ların connection_config'i sadece
// {"field": "..."} taşır (kimlik tekrarı yok). Verimlilik için serverStatus cihaz+tur
// başına BİR KEZ çekilip cache'lenir; bir turdaki tüm mongodb item'ları aynı snapshot'ı
// okur.

interface MongoSource { ts: number; serverStatus?: any; repl?: any; error?: string; }
const mongoCache = new Map<string, MongoSource>();
const MONGO_TTL_MS = 50000; // < POLL_INTERVAL (60s): her turda bir kez çekilir, item'lar paylaşır

function getPath(obj: any, path: string): any {
  let cur = obj;
  for (const key of path.split(".")) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

// serverStatus sayaçları number/BigInt/Long (bson) olabilir -> güvenli sayıya çevir.
function toNumber(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isNaN(v) ? null : v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "object" && typeof v.valueOf === "function") {
    const n = Number(v.valueOf());
    if (!Number.isNaN(n)) return n;
  }
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// Replica set gecikmesi (sn): sorgulanan üye (self) ile PRIMARY optime farkı.
function computeReplLag(repl: any): number | null {
  if (!repl?.members) return null;
  const self = repl.members.find((m: any) => m.self);
  const primary = repl.members.find((m: any) => m.stateStr === "PRIMARY");
  if (!self?.optimeDate || !primary?.optimeDate) return null;
  const lag = (new Date(primary.optimeDate).getTime() - new Date(self.optimeDate).getTime()) / 1000;
  return Math.max(0, lag);
}

async function getMongoSource(device: DeviceRow): Promise<MongoSource> {
  const cached = mongoCache.get(device.id);
  if (cached && Date.now() - cached.ts < MONGO_TTL_MS) return cached;

  const entry: MongoSource = { ts: Date.now() };
  // Kimlikleri sabit makrolarla çöz (item'lardan bağımsız). Makro yoksa "" döner ->
  // kimliksiz bağlanılır.
  const creds = (await fetchResolvedConfig(device.id, {
    username: "{$MONGO_USER}", password: "{$MONGO_PASSWORD}", port: "{$MONGO_PORT}", auth_db: "{$MONGO_AUTH_DB}"
  })) || {};
  const user: string = creds.username || "";
  const pass: string = creds.password ?? creds.secret ?? "";
  const port = Number(creds.port) || 27017;
  const authDb = creds.auth_db || "admin";
  const authPart = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : "";
  // directConnection=true: tek mongod'a bağlan (SRV/replset keşfine takılma).
  const uri = `mongodb://${authPart}${device.ip_address}:${port}/?authSource=${authDb}&directConnection=true&serverSelectionTimeoutMS=5000&connectTimeoutMS=5000`;

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const admin = client.db("admin").admin();
    entry.serverStatus = await admin.serverStatus();
    // replSetGetStatus standalone'da hata verir -> yut, repl=null (repl item'ları sessiz atlanır).
    try { entry.repl = await admin.command({ replSetGetStatus: 1 }); } catch { entry.repl = null; }
    await reportCollectorStatus(device.id, "active", undefined, "mongodb");
  } catch (err: any) {
    entry.error = err.message;
    await reportCollectorStatus(device.id, "down", err.message, "mongodb");
  } finally {
    await client.close().catch(() => {});
  }

  mongoCache.set(device.id, entry);
  return entry;
}

async function pollMongoItem(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<string | undefined> {
  const field: string | undefined = item.connection_config?.field;
  if (!field) return "field tanımlı değil";

  const src = await getMongoSource(device);

  const publishValue = (value: number, unit?: string) => publishMetric({
    event_type: "metric", source_module: "sql-collector", tenant_id: device.tenant_id, device_id: device.id,
    metric_name: item.metric_name, timestamp, value, unit: unit ?? item.unit ?? undefined
  });

  if (src.error) {
    // Bağlantı başarısız: reachable item'ı 0 yayınlar (erişilemezlik ölçüsü); diğer
    // item'lar veri üretemez, hata mesajı döner (Queue'daki last_error'a yansır).
    if (field === "reachable") { await publishValue(0, "status"); return undefined; }
    return src.error;
  }

  let value: number | null;
  if (field === "reachable") value = 1;
  else if (field === "repl_state") { if (!src.repl) return undefined; value = toNumber(src.repl.myState); }
  else if (field === "repl_lag") { if (!src.repl) return undefined; value = computeReplLag(src.repl); }
  else value = toNumber(getPath(src.serverStatus, field));

  if (value === null) return `alan bulunamadı/sayısal değil: ${field}`;
  await publishValue(value);
  console.log(`[Mongo] ${device.name}: ${item.metric_name} = ${value}`);
  return undefined;
}

// Faz Queue-audit: erken-cikis noktalari ve catch bloğu artik bir hata mesaji
// (string) donduruyor -- oncesinde sadece console.log'a yazilip yutuluyordu.
export async function pollSqlItem(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<string | undefined> {
  // MongoDB SQL değildir (sorgu yok, fan-out çalışır) -> kendi sürücüsüne yönlendir.
  if (item.collector_type === "mongodb") return pollMongoItem(device, item, timestamp);

  const itemConfig = item.connection_config;
  if (!itemConfig?.query) {
    const msg = "query tanımlı değil";
    console.log(`[SQL] ${device.name} ${item.metric_name}: ${msg}`);
    return msg;
  }

  // connection_config içindeki {$SQL_PORT}/{$SQL_DATABASE}/{$SQL_USER}/{$SQL_PASSWORD} gibi
  // makro referanslarını bu cihaz için çözer — host hâlâ device.ip_address'ten gelir.
  const resolved = await fetchResolvedConfig(device.id, itemConfig);
  if (!resolved) {
    const msg = "bağlantı bilgisi çözülemedi (Core Service'e ulaşılamadı)";
    console.log(`[SQL] ${device.name} ${item.metric_name}: ${msg}`);
    return msg;
  }

  const username: string | undefined = resolved.username;
  const password: string | undefined = resolved.password ?? resolved.secret;
  const database: string | undefined = resolved.database;
  if (!username || !password || !database) {
    const msg = "SQL bağlantı bilgisi eksik — bu cihaz için ayarlanmamış";
    console.log(`[SQL] ${device.name} ${item.metric_name}: ${msg}`);
    return msg;
  }

  const defaultPort = item.collector_type === "sql_mysql" ? 3306 : 5432;
  const port = Number(resolved.port) || defaultPort;

  try {
    const value = item.collector_type === "sql_mysql"
      ? await runMysqlQuery(device.ip_address, port, database, username, password, itemConfig.query)
      : await runPostgresQuery(device.ip_address, port, database, username, password, itemConfig.query);

    if (value === null || Number.isNaN(value)) {
      const msg = "sonuç sayı değil veya boş";
      console.log(`[SQL] ${device.name} ${item.metric_name}: ${msg}`);
      return msg;
    }

    await publishMetric({
      event_type: "metric", source_module: "sql-collector", tenant_id: device.tenant_id, device_id: device.id,
      metric_name: item.metric_name, timestamp, value, unit: item.unit || undefined
    });
    console.log(`[SQL] ${device.name}: ${item.metric_name} = ${value}`);
    await reportCollectorStatus(device.id, "active", undefined, item.collector_type);
    return undefined;
  } catch (err: any) {
    console.log(`[SQL] ${device.name} ${item.metric_name} hata: ${err.message}`);
    await reportCollectorStatus(device.id, "down", err.message, item.collector_type);
    return err.message;
  }
}
