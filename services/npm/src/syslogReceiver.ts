import dgram from "dgram";
import { pool } from "./db.js";
import { publishMetric } from "./redisClient.js";

// SYSLOG TOPLAYICI (Pasif Log). SNMP Trap alıcısıyla (trapReceiver.ts) AYNI mimari:
// pasif dinleyici -> kaynak IP ile devices eşleştirme -> yayınlama. FARKI: trap'te
// asıl bilgi trap TÜRÜdür (instance_label'a sığar); syslog'da asıl bilgi serbest-metin
// MESAJDIR. Metrik hattı (metrics-consumer) tags'ten sadece instance_label/interface
// tutup gerisini attığı için mesaj metnini o hattan geçiremeyiz -- bu yüzden receiver,
// mesajı KENDİ tablosuna (syslog_messages) DOĞRUDAN yazar. Alarm motoru yine çalışsın
// diye severity'yi ayrıca bir metrik (syslog_message) olarak yayınlar; ayrıca kullanıcı
// tanımlı regex desenlerine (syslog_patterns) uyan mesajlar için adlandırılmış metrik
// yayınlar (mevcut şablon/alarm sistemi bu metrik adı üzerinden kural tanımlar).
//
// TASARIM NOTU (net-snmp yerine dgram): syslog ham UDP metnidir; ekstra bir npm paketi
// (syslog-server vb.) yerine Node'un yerleşik dgram modülü hem yeterli hem bağımlılık
// eklemez. RFC 3164 (BSD) ve RFC 5424 (yeni) formatlarının ikisi de ayrıştırılır.

// RFC 5424 severity (0=en ciddi ... 7=en az ciddi). Alarm kurarken kullanıcı
// 'syslog_message' metriğinde value <= 3 (err/crit/alert/emerg) gibi bir eşik kullanır.
const SEVERITY_NAMES = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"];

interface ParsedSyslog {
  facility: number | null;
  severity: number;
  severityName: string;
  hostname: string | null;
  appname: string | null;
  message: string;
}

// <PRI> = facility*8 + severity. PRI yoksa (bazı cihazlar göndermez) severity=notice
// (5) varsayılır -- bilinmeyen ciddiyette bir mesajı sessizce en düşük seviyeye
// atmamak için orta bir değer.
function parseSyslog(raw: string): ParsedSyslog {
  let facility: number | null = null;
  let severity = 5;
  let rest = raw;

  const priMatch = raw.match(/^<(\d{1,3})>/);
  if (priMatch) {
    const pri = Number(priMatch[1]);
    facility = pri >> 3;
    severity = pri & 0x07;
    rest = raw.slice(priMatch[0].length);
  }

  let hostname: string | null = null;
  let appname: string | null = null;
  let message = rest.trim();

  // RFC 5424: "<PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID [SD] MSG"
  // PRI ayrıldıktan sonra ilk token '1 ' ise (VERSION) 5424'tür.
  const v5424 = rest.match(/^1\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(?:\[.*?\]|-)?\s*(.*)$/s);
  if (v5424) {
    hostname = v5424[2] === "-" ? null : v5424[2];
    appname = v5424[3] === "-" ? null : v5424[3];
    message = (v5424[6] || "").trim();
    return { facility, severity, severityName: SEVERITY_NAMES[severity] || "unknown", hostname, appname, message };
  }

  // RFC 3164 (BSD): "Mmm dd hh:mm:ss HOSTNAME TAG[pid]: message"
  // Zaman damgası genelde 15 karakterdir; onu atlayıp HOSTNAME + TAG çıkarıyoruz.
  const v3164 = rest.match(/^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(.*)$/s);
  if (v3164) {
    hostname = v3164[2];
    const tail = v3164[3];
    const tagMatch = tail.match(/^([\w\-\/.]+)(?:\[\d+\])?:\s*(.*)$/s);
    if (tagMatch) {
      appname = tagMatch[1];
      message = tagMatch[2].trim();
    } else {
      message = tail.trim();
    }
    return { facility, severity, severityName: SEVERITY_NAMES[severity] || "unknown", hostname, appname, message };
  }

  // Hiçbir formata uymadıysa: ham gövdeyi mesaj olarak al (yine de saklanır).
  return { facility, severity, severityName: SEVERITY_NAMES[severity] || "unknown", hostname, appname, message };
}

// Kaynak IP -> cihaz eşleştirme (trapReceiver.ts ile BİREBİR aynı sorgu deseni):
// hem device_interfaces (snmp interface) hem devices.ip_address'e bakılır.
async function matchDevice(sourceIp: string): Promise<{ id: string; tenant_id: string; name: string } | null> {
  const result = await pool.query(
    `SELECT d.id, d.tenant_id, d.name
     FROM devices d
     LEFT JOIN device_interfaces di ON di.device_id = d.id AND di.interface_type = 'snmp'
     WHERE COALESCE(di.ip_address, host(d.ip_address)) = $1
     LIMIT 1`,
    [sourceIp]
  );
  return result.rows[0] || null;
}

// PATTERN CACHE: syslog hacimli olabilir; her mesajda syslog_patterns'i DB'den çekmek
// darboğaz olur. Tenant başına desenleri kısa TTL ile (30sn) bellekte tutuyoruz --
// kullanıcı yeni desen eklediğinde en geç 30sn içinde etkin olur.
interface CachedPattern { name: string; re: RegExp | null; metric_name: string; min_severity: number; }
const patternCache = new Map<string, { loadedAt: number; patterns: CachedPattern[] }>();
const PATTERN_TTL_MS = 30000;

async function getPatterns(tenantId: string): Promise<CachedPattern[]> {
  const cached = patternCache.get(tenantId);
  if (cached && Date.now() - cached.loadedAt < PATTERN_TTL_MS) return cached.patterns;

  const result = await pool.query(
    `SELECT name, regex, metric_name, min_severity FROM syslog_patterns WHERE tenant_id = $1 AND enabled`,
    [tenantId]
  );
  const patterns: CachedPattern[] = result.rows.map((row: any) => {
    let re: RegExp | null = null;
    try {
      re = new RegExp(row.regex, "i");
    } catch {
      // Geçersiz regex kullanıcı hatası -- collector'ı çökertmemeli, o desen atlanır.
      console.error(`[Syslog] Geçersiz regex (desen '${row.name}'): ${row.regex}`);
    }
    return { name: row.name, re, metric_name: row.metric_name, min_severity: row.min_severity };
  });
  patternCache.set(tenantId, { loadedAt: Date.now(), patterns });
  return patterns;
}

async function handleMessage(raw: string, sourceIp: string) {
  const device = await matchDevice(sourceIp);
  if (!device) {
    // Trap ile aynı davranış: izlemediğimiz bir kaynaktan gelen syslog göz ardı edilir
    // (log spam'ini önlemek için burada console'a da yazmıyoruz -- syslog çok sık gelir).
    return;
  }

  const parsed = parseSyslog(raw);
  const now = new Date().toISOString();

  // 1) Ham mesajı kendi tablosuna yaz (Syslog Log widget'ı buradan okur).
  await pool.query(
    `INSERT INTO syslog_messages (time, tenant_id, device_id, facility, severity, severity_name, hostname, appname, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [now, device.tenant_id, device.id, parsed.facility, parsed.severity, parsed.severityName, parsed.hostname, parsed.appname, parsed.message]
  );

  // 2) Severity metriği -- alarm motoru "bu cihazdan err+ syslog geldi" kuralı
  //    kurabilsin diye. value = severity (0..7, düşük = daha ciddi), instance_label =
  //    okunur ad (per-severity gruplama/alarm için, 075 tag-farkında motorla tutarlı).
  await publishMetric({
    event_type: "metric",
    source_module: "npm",
    tenant_id: device.tenant_id,
    device_id: device.id,
    metric_name: "syslog_message",
    timestamp: now,
    value: parsed.severity,
    tags: { instance_label: parsed.severityName }
  });

  // 3) Kullanıcı-tanımlı desenler: uyan her desen için adlandırılmış bir metrik yayınla.
  //    Desen, SADECE severity yeterince ciddiyse (severity <= min_severity) denenir.
  const patterns = await getPatterns(device.tenant_id);
  for (const p of patterns) {
    if (!p.re) continue;
    if (parsed.severity > p.min_severity) continue;
    if (p.re.test(parsed.message)) {
      await publishMetric({
        event_type: "metric",
        source_module: "npm",
        tenant_id: device.tenant_id,
        device_id: device.id,
        metric_name: p.metric_name,
        timestamp: now,
        value: 1,
        tags: { instance_label: p.name }
      });
      console.log(`[Syslog] ${device.name}: '${p.name}' deseni eşleşti -> metrik '${p.metric_name}'`);
    }
  }
}

let socket: dgram.Socket | null = null;

export function startSyslogReceiver() {
  const port = Number(process.env.SYSLOG_PORT) || 1514; // gerçek 514 admin/CAP_NET_BIND yetkisi ister
  socket = dgram.createSocket("udp4");

  socket.on("error", (err) => {
    console.error("[Syslog] Soket hatası:", err);
  });

  socket.on("message", (msg, rinfo) => {
    // Her mesaj bağımsız işlenir; birinin hatası diğerlerini/collector'ı etkilemesin.
    handleMessage(msg.toString("utf8"), rinfo.address).catch((err) => {
      console.error("[Syslog] İşleme hatası:", err);
    });
  });

  socket.bind(port, "0.0.0.0", () => {
    console.log(`[Syslog] Alıcı hazır: UDP ${port}`);
  });
}

export function stopSyslogReceiver() {
  socket?.close();
  socket = null;
}
