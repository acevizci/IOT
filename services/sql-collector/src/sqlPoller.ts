import pg from "pg";
import mysql from "mysql2/promise";
import { MongoClient } from "mongodb";
import { Kafka, logLevel } from "kafkajs";
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

// ============ KAFKA (fan-out) ============
// MongoDB deseninin aynısı: küresel bundle (cluster + topics + metadata + groups) cihaz+
// tur başına TEK admin bağlantısıyla çekilip cache'lenir; küresel item'lar oradan okur.
// Consumer lag AYRI: item 'group' taşır, kendi committed offset'ini çeker, topic
// end-offset'lerini tur-cache'ten alır (watch-list = kullanıcının eklediği lag item'ları).

interface KafkaConn { port: number; user: string; pass: string; saslMechanism: string; ssl: boolean; }
interface KafkaSource { ts: number; conn?: KafkaConn; metrics?: Record<string, number>; error?: string; }

const kafkaCache = new Map<string, KafkaSource>();
const kafkaTopicOffsetCache = new Map<string, { ts: number; ends: Map<number, number> }>();
const KAFKA_TTL_MS = 50000;

async function resolveKafkaConn(deviceId: string): Promise<KafkaConn> {
  const c = (await fetchResolvedConfig(deviceId, {
    port: "{$KAFKA_PORT}", user: "{$KAFKA_USER}", pass: "{$KAFKA_PASSWORD}",
    sasl_mechanism: "{$KAFKA_SASL_MECHANISM}", ssl: "{$KAFKA_SSL}"
  })) || {};
  return {
    port: Number(c.port) || 9092,
    user: c.user || "",
    pass: c.pass ?? c.secret ?? "",
    saslMechanism: c.sasl_mechanism || "plain",
    ssl: String(c.ssl).toLowerCase() === "true"
  };
}

function buildKafka(device: DeviceRow, conn: KafkaConn): Kafka {
  const cfg: any = {
    clientId: "iot-observability",
    brokers: [`${device.ip_address}:${conn.port}`],
    connectionTimeout: 5000, requestTimeout: 5000,
    logLevel: logLevel.NOTHING,
    retry: { retries: 1 }
  };
  if (conn.user) cfg.sasl = { mechanism: conn.saslMechanism, username: conn.user, password: conn.pass };
  if (conn.ssl) cfg.ssl = true;
  return new Kafka(cfg);
}

async function getKafkaSource(device: DeviceRow): Promise<KafkaSource> {
  const cached = kafkaCache.get(device.id);
  if (cached && Date.now() - cached.ts < KAFKA_TTL_MS) return cached;

  const entry: KafkaSource = { ts: Date.now() };
  const conn = await resolveKafkaConn(device.id);
  entry.conn = conn;
  const admin = buildKafka(device, conn).admin();
  try {
    await admin.connect();
    const cluster = await admin.describeCluster();
    const topics = await admin.listTopics();
    const userTopics = topics.filter((t) => !t.startsWith("__")); // internal topic'leri hariç tut
    const metadata = await admin.fetchTopicMetadata();
    let partitionCount = 0, urp = 0, offline = 0;
    for (const t of metadata.topics) {
      for (const p of t.partitions) {
        partitionCount++;
        if (p.isr.length < p.replicas.length) urp++;
        if (p.leader === -1) offline++;
      }
    }
    const groups = await admin.listGroups();
    entry.metrics = {
      broker_count: cluster.brokers.length,
      controller_present: cluster.controller != null && cluster.controller >= 0 ? 1 : 0,
      topic_count: userTopics.length,
      partition_count: partitionCount,
      under_replicated_partitions: urp,
      offline_partitions: offline,
      consumer_group_count: groups.groups.length
    };
    await reportCollectorStatus(device.id, "active", undefined, "kafka");
  } catch (err: any) {
    entry.error = err.message;
    await reportCollectorStatus(device.id, "down", err.message, "kafka");
  } finally {
    await admin.disconnect().catch(() => {});
  }
  kafkaCache.set(device.id, entry);
  return entry;
}

async function getTopicEndOffsets(device: DeviceRow, admin: any, topic: string): Promise<Map<number, number>> {
  const key = `${device.id}:${topic}`;
  const cached = kafkaTopicOffsetCache.get(key);
  if (cached && Date.now() - cached.ts < KAFKA_TTL_MS) return cached.ends;
  const arr = await admin.fetchTopicOffsets(topic); // [{partition, offset, high, low}]
  const ends = new Map<number, number>();
  for (const p of arr) ends.set(p.partition, Number(p.high));
  kafkaTopicOffsetCache.set(key, { ts: Date.now(), ends });
  return ends;
}

async function pollKafkaItem(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<string | undefined> {
  const field: string | undefined = item.connection_config?.field;
  if (!field) return "field tanımlı değil";

  const publishValue = (value: number, unit?: string, instanceLabel?: string) => publishMetric({
    event_type: "metric", source_module: "sql-collector", tenant_id: device.tenant_id, device_id: device.id,
    metric_name: item.metric_name, timestamp, value, unit: unit ?? item.unit ?? undefined,
    tags: instanceLabel ? { instance_label: instanceLabel } : undefined
  });

  // Consumer lag: per-group, kendi bağlantısını açar (watch-list ile sınırlı).
  if (field === "consumer_lag") {
    const group: string | undefined = item.connection_config?.group;
    if (!group) return "consumer_lag için group tanımlı değil";
    const src = await getKafkaSource(device); // conn parametrelerini (+reachability) buradan al
    if (src.error || !src.conn) return src.error || "bağlantı bilgisi yok";
    const topicFilter: string | undefined = item.connection_config?.topic;
    const admin = buildKafka(device, src.conn).admin();
    try {
      await admin.connect();
      const committed = await admin.fetchOffsets({ groupId: group, ...(topicFilter ? { topics: [topicFilter] } : {}) });
      let lag = 0;
      for (const t of committed) {
        const ends = await getTopicEndOffsets(device, admin, t.topic);
        for (const p of t.partitions) {
          const c = Number(p.offset);
          if (c < 0) continue; // henüz commit yok
          const end = ends.get(p.partition);
          if (end == null) continue;
          lag += Math.max(0, end - c);
        }
      }
      await publishValue(lag, "mesaj", group);
      console.log(`[Kafka] ${device.name}: ${item.metric_name}[${group}] = ${lag}`);
      return undefined;
    } catch (err: any) {
      console.log(`[Kafka] ${device.name} lag[${group}] hata: ${err.message}`);
      return err.message;
    } finally {
      await admin.disconnect().catch(() => {});
    }
  }

  // Küresel metrikler: cache'lenmiş bundle'dan.
  const src = await getKafkaSource(device);
  if (src.error) {
    if (field === "reachable") { await publishValue(0, "status"); return undefined; }
    return src.error;
  }
  const value = field === "reachable" ? 1 : src.metrics?.[field];
  if (value === undefined || value === null) return `bilinmeyen alan: ${field}`;
  await publishValue(value);
  console.log(`[Kafka] ${device.name}: ${item.metric_name} = ${value}`);
  return undefined;
}

// ============ RABBITMQ (fan-out) ============
// Mongo/Kafka deseninin aynısı, ama metrikler Management HTTP API'sinden gelir (AMQP
// değil). /api/overview + /api/nodes cihaz+tur başına BİR KEZ çekilip cache'lenir; küresel
// item'lar oradan okur. Per-queue derinliği ayrı: item 'queue' taşır, /api/queues'tan
// kendi kuyruğunu çeker (watch-list = kullanıcının eklediği queue item'ları).

interface RabbitSource { ts: number; metrics?: Record<string, number>; auth?: string; baseUrl?: string; error?: string; }
const rabbitCache = new Map<string, RabbitSource>();
const RABBIT_TTL_MS = 50000;

const boolNum = (v: any): number => (v === true ? 1 : 0);

async function rabbitFetchJson(url: string, auth: string, timeoutMs = 5000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Authorization: auth }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getRabbitSource(device: DeviceRow): Promise<RabbitSource> {
  const cached = rabbitCache.get(device.id);
  if (cached && Date.now() - cached.ts < RABBIT_TTL_MS) return cached;

  const entry: RabbitSource = { ts: Date.now() };
  const creds = (await fetchResolvedConfig(device.id, {
    user: "{$RABBITMQ_USER}", pass: "{$RABBITMQ_PASSWORD}", port: "{$RABBITMQ_MGMT_PORT}"
  })) || {};
  const user = creds.user || "guest";
  const pass = creds.pass ?? creds.secret ?? "guest";
  const port = Number(creds.port) || 15672;
  const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  const baseUrl = `http://${device.ip_address}:${port}`;
  entry.auth = auth;
  entry.baseUrl = baseUrl;

  try {
    const overview = await rabbitFetchJson(`${baseUrl}/api/overview`, auth);
    const nodes = await rabbitFetchJson(`${baseUrl}/api/nodes`, auth);
    const n = Array.isArray(nodes) && nodes.length ? nodes[0] : {};
    const qt = overview.queue_totals || {};
    const ms = overview.message_stats || {};
    const ot = overview.object_totals || {};
    // message_stats trafik yoksa hiç gelmeyebilir -> rate'ler için 0 varsayılır.
    const rate = (o: any) => (o && o.rate != null ? Number(o.rate) : 0);
    entry.metrics = {
      messages_total: Number(qt.messages || 0),
      messages_ready: Number(qt.messages_ready || 0),
      messages_unacked: Number(qt.messages_unacknowledged || 0),
      publish_rate: rate(ms.publish_details),
      deliver_rate: rate(ms.deliver_get_details),
      ack_rate: rate(ms.ack_details),
      connections: Number(ot.connections || 0),
      channels: Number(ot.channels || 0),
      consumers: Number(ot.consumers || 0),
      queues: Number(ot.queues || 0),
      node_mem_used: Number(n.mem_used || 0),
      node_mem_limit: Number(n.mem_limit || 0),
      node_disk_free: Number(n.disk_free || 0),
      node_fd_used: Number(n.fd_used || 0),
      mem_alarm: boolNum(n.mem_alarm),
      disk_alarm: boolNum(n.disk_free_alarm),
      node_running: boolNum(n.running)
    };
    await reportCollectorStatus(device.id, "active", undefined, "rabbitmq");
  } catch (err: any) {
    entry.error = err.message;
    await reportCollectorStatus(device.id, "down", err.message, "rabbitmq");
  }
  rabbitCache.set(device.id, entry);
  return entry;
}

async function pollRabbitItem(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<string | undefined> {
  const field: string | undefined = item.connection_config?.field;
  if (!field) return "field tanımlı değil";

  const publishValue = (value: number, unit?: string, instanceLabel?: string) => publishMetric({
    event_type: "metric", source_module: "sql-collector", tenant_id: device.tenant_id, device_id: device.id,
    metric_name: item.metric_name, timestamp, value, unit: unit ?? item.unit ?? undefined,
    tags: instanceLabel ? { instance_label: instanceLabel } : undefined
  });

  const src = await getRabbitSource(device);

  // Per-queue derinliği: /api/queues/<vhost>/<queue> (watch-list).
  if (field === "queue_messages") {
    const queue: string | undefined = item.connection_config?.queue;
    if (!queue) return "queue_messages için queue tanımlı değil";
    if (src.error || !src.baseUrl || !src.auth) return src.error || "bağlantı bilgisi yok";
    const vhost: string = item.connection_config?.vhost || "/";
    try {
      const q = await rabbitFetchJson(
        `${src.baseUrl}/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queue)}`, src.auth
      );
      await publishValue(Number(q.messages || 0), "mesaj", queue);
      console.log(`[Rabbit] ${device.name}: ${item.metric_name}[${queue}] = ${q.messages}`);
      return undefined;
    } catch (err: any) {
      console.log(`[Rabbit] ${device.name} queue[${queue}] hata: ${err.message}`);
      return err.message;
    }
  }

  // Küresel metrikler: cache'lenmiş overview+nodes'tan.
  if (src.error) {
    if (field === "reachable") { await publishValue(0, "status"); return undefined; }
    return src.error;
  }
  const value = field === "reachable" ? 1 : src.metrics?.[field];
  if (value === undefined || value === null) return `bilinmeyen alan: ${field}`;
  await publishValue(value);
  console.log(`[Rabbit] ${device.name}: ${item.metric_name} = ${value}`);
  return undefined;
}

// Faz Queue-audit: erken-cikis noktalari ve catch bloğu artik bir hata mesaji
// (string) donduruyor -- oncesinde sadece console.log'a yazilip yutuluyordu.
export async function pollSqlItem(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<string | undefined> {
  // MongoDB SQL değildir (sorgu yok, fan-out çalışır) -> kendi sürücüsüne yönlendir.
  if (item.collector_type === "mongodb") return pollMongoItem(device, item, timestamp);
  if (item.collector_type === "kafka") return pollKafkaItem(device, item, timestamp);
  if (item.collector_type === "rabbitmq") return pollRabbitItem(device, item, timestamp);

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
