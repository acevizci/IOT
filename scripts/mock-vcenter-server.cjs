#!/usr/bin/env node
// FAZ J — Sahte vCenter REST API sunucusu (test amaçlı).
//
// GERÇEK vSphere Automation API'nin (vCenter 7.0+) belgelenmiş şekli ile BİREBİR
// aynı endpoint'leri, header'ları ve JSON alan adlarını taklit eder -- SNMP-Sim-01'in
// gerçek donanım olmadan SNMP testleri yapmayı sağlaması gibi, bu da vmware-collector'ın
// GERÇEK mantığını (oturum açma, sayfalama, hata yönetimi, veri ayrıştırma) uçtan uca
// test etmemizi sağlar. Performans sayaçları (CPU/RAM/disk KULLANIM yüzdeleri) BİLEREK
// YOK -- bunlar gerçek vSphere'de PerformanceManager (SOAP) gerektirir, bu mock onu
// taklit etmiyor (yanıltıcı olurdu). Sadece envanter/durum verisi (VM listesi, power
// state, host, datastore, cluster) mock'lanıyor -- bunlar REST API'de GERÇEKTEN var.
//
// Kimlik doğrulama: sabit kullanıcı/şifre (test-user / test-pass123).

const http = require("http");
const crypto = require("crypto");

const PORT = process.env.MOCK_VCENTER_PORT || 8443;
const VALID_USER = "test-user";
const VALID_PASS = "test-pass123";
const activeSessions = new Set();

// 20 sahte VM -- bazıları açık, bazıları kapalı (gerçekçi çeşitlilik için).
// host: her VM, 2 host arasında dönüşümlü paylaştırılıyor (gerçekçi bir küme).
const VMS = Array.from({ length: 20 }, (_, i) => ({
  vm: `vm-${1000 + i}`,
  name: `test-vm-${String(i).padStart(2, "0")}`,
  power_state: i % 7 === 0 ? "POWERED_OFF" : (i % 11 === 0 ? "SUSPENDED" : "POWERED_ON"),
  cpu_count: [2, 4, 8][i % 3],
  memory_size_MiB: [2048, 4096, 8192, 16384][i % 4],
  host: i % 2 === 0 ? "host-1" : "host-2"
}));

const HOSTS = [
  { host: "host-1", name: "esxi-01.lab.local", connection_state: "CONNECTED", power_state: "POWERED_ON", cluster: "domain-c1" },
  { host: "host-2", name: "esxi-02.lab.local", connection_state: "CONNECTED", power_state: "POWERED_ON", cluster: "domain-c1" }
];

const DATASTORES = [
  { datastore: "datastore-1", name: "datastore1", type: "VMFS", free_space: 500 * 1024 ** 3, capacity: 2000 * 1024 ** 3 },
  { datastore: "datastore-2", name: "datastore2", type: "NFS", free_space: 100 * 1024 ** 3, capacity: 1000 * 1024 ** 3 }
];

const CLUSTERS = [
  { cluster: "domain-c1", name: "Production-Cluster", drs_enabled: true, ha_enabled: true }
];

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

function requireSession(req, res) {
  const sessionId = req.headers["vmware-api-session-id"];
  if (!sessionId || !activeSessions.has(sessionId)) {
    send(res, 401, { type: "com.vmware.vapi.std.errors.unauthenticated", messages: [{ default_message: "Geçersiz veya süresi dolmuş oturum" }] });
    return false;
  }
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  console.log(`[MockVCenter] ${req.method} ${url.pathname}`);

  if (url.pathname === "/api/session" && req.method === "POST") {
    const authHeader = req.headers["authorization"] || "";
    const [scheme, encoded] = authHeader.split(" ");
    if (scheme !== "Basic" || !encoded) {
      return send(res, 401, { type: "com.vmware.vapi.std.errors.unauthenticated", messages: [{ default_message: "Authorization header eksik" }] });
    }
    const [user, pass] = Buffer.from(encoded, "base64").toString("utf-8").split(":");
    if (user !== VALID_USER || pass !== VALID_PASS) {
      return send(res, 401, { type: "com.vmware.vapi.std.errors.unauthenticated", messages: [{ default_message: "Kullanıcı adı/şifre hatalı" }] });
    }
    const sessionId = crypto.randomBytes(16).toString("hex");
    activeSessions.add(sessionId);
    console.log(`[MockVCenter] Oturum açıldı: ${sessionId.slice(0, 8)}...`);
    return send(res, 201, sessionId); // GERÇEK API: body doğrudan tırnaklı bir string (JSON string)
  }

  if (url.pathname === "/api/session" && req.method === "DELETE") {
    const sessionId = req.headers["vmware-api-session-id"];
    activeSessions.delete(sessionId);
    return send(res, 204, null);
  }

  if (url.pathname === "/api/vcenter/vm" && req.method === "GET") {
    if (!requireSession(req, res)) return;
    return send(res, 200, VMS);
  }

  if (url.pathname === "/api/vcenter/host" && req.method === "GET") {
    if (!requireSession(req, res)) return;
    return send(res, 200, HOSTS);
  }

  if (url.pathname === "/api/vcenter/datastore" && req.method === "GET") {
    if (!requireSession(req, res)) return;
    return send(res, 200, DATASTORES);
  }

  if (url.pathname === "/api/vcenter/cluster" && req.method === "GET") {
    if (!requireSession(req, res)) return;
    return send(res, 200, CLUSTERS);
  }

  // TEST KONTROLÜ -- gerçek vSphere API'sinin PARÇASI DEĞİL (path /api/vcenter/*
  // dışında, kasıtlı). Sadece "kaybolan VM tespiti" mantığını test edebilmek için --
  // bir VM'i listeden çıkarıp collector'ın N ardışık turda bunu fark edip fark
  // etmediğini görebilelim diye.
  if (url.pathname === "/test/remove-vm" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { name } = JSON.parse(body || "{}");
      const idx = VMS.findIndex((v) => v.name === name);
      if (idx >= 0) {
        VMS.splice(idx, 1);
        console.log(`[MockVCenter] TEST: VM '${name}' listeden kaldırıldı`);
      }
      send(res, 200, { removed: idx >= 0 });
    });
    return;
  }

  // ============ SOAP /sdk -- vSphere Web Services API (VIM25), SADECE
  // PerformanceManager alt kümesi (gerçek CPU/RAM/disk KULLANIM yüzdeleri için).
  // Bu, REST API'nin (yukarıdaki /api/vcenter/*) KAPSAMADIĞI eski/klasik VMware
  // API'si -- SOAP zarfları, oturum çerezi, ve VMware'in "önce sayaç kataloğunu
  // keşfet (counterId'ler vCenter kurulumuna göre DEĞİŞİR, sabit değildir),
  // sonra entity başına hangi sayaçların mevcut olduğunu sorgula, en son gerçek
  // değerleri çek" üç aşamalı modelini TAKLİT EDER. Basitleştirme notu: gerçek
  // VMware'de sayaç metadata'sı PropertyCollector'ın genel RetrievePropertiesEx
  // mekanizmasından gelir -- burada DOĞRUDAN bir kısayol (RetrievePerfCounters)
  // olarak sunuluyor, kavramsal olarak AYNI veriyi (PerfCounterInfo listesi)
  // taşıyor ama gerçek çağrı yolunu birebir taklit etmiyor.
  if (url.pathname === "/sdk" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const soapRes = (inner) =>
        `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
      const sendXml = (status, xml) => {
        res.writeHead(status, { "Content-Type": "text/xml; charset=utf-8" });
        res.end(xml);
      };
      const cookie = req.headers["cookie"] || "";
      const hasSession = cookie.includes("vmware_soap_session=mock-soap-session");

      if (body.includes("<Login") || body.includes(":Login>")) {
        const userMatch = body.match(/<(?:\w+:)?userName>(.*?)<\/(?:\w+:)?userName>/);
        const passMatch = body.match(/<(?:\w+:)?password>(.*?)<\/(?:\w+:)?password>/);
        if (userMatch?.[1] !== VALID_USER || passMatch?.[1] !== VALID_PASS) {
          return sendXml(500, soapRes(`<soapenv:Fault><faultstring>InvalidLogin</faultstring></soapenv:Fault>`));
        }
        res.setHeader("Set-Cookie", "vmware_soap_session=mock-soap-session; Path=/sdk");
        return sendXml(200, soapRes(`<LoginResponse xmlns="urn:vim25"><returnval><key>mock-soap-session</key><userName>${VALID_USER}</userName></returnval></LoginResponse>`));
      }

      if (body.includes("RetrieveServiceContent")) {
        // Oturum GEREKTİRMEZ (gerçek VMware'de de öyle -- bu, oturum açmadan
        // ÖNCE hangi servislerin (SessionManager/PerformanceManager) nerede
        // olduğunu keşfetmek için kullanılır).
        return sendXml(200, soapRes(
          `<RetrieveServiceContentResponse xmlns="urn:vim25"><returnval>` +
          `<sessionManager type="SessionManager">SessionManager</sessionManager>` +
          `<perfManager type="PerformanceManager">PerfManager</perfManager>` +
          `</returnval></RetrieveServiceContentResponse>`
        ));
      }

      if (!hasSession) {
        return sendXml(500, soapRes(`<soapenv:Fault><faultstring>NotAuthenticated</faultstring></soapenv:Fault>`));
      }

      if (body.includes("RetrievePerfCounters") || body.includes("perfCounter")) {
        // Sabit bir sayaç kataloğu -- counterId'ler bu mock için sabit ama
        // GERÇEK vCenter'da HER KURULUMDA FARKLI olabilir (bu yüzden istemci
        // KOD İÇİNDE counterId'yi asla SABİT KODLAMAMALI, her zaman bu listeden
        // groupInfo.key+nameInfo.key ile ARAMALI).
        const counters = [
          { id: 2, group: "cpu", name: "usage", unit: "percent", rollup: "average" },
          { id: 24, group: "mem", name: "usage", unit: "percent", rollup: "average" },
          { id: 100, group: "disk", name: "usage", unit: "kiloBytesPerSecond", rollup: "average" },
          { id: 200, group: "net", name: "usage", unit: "kiloBytesPerSecond", rollup: "average" }
        ];
        const xml = counters.map((c) =>
          `<returnval><key>${c.id}</key><groupInfo><key>${c.group}</key></groupInfo><nameInfo><key>${c.name}</key></nameInfo><unitInfo><key>${c.unit}</key></unitInfo><rollupType>${c.rollup}</rollupType><statsType>rate</statsType></returnval>`
        ).join("");
        return sendXml(200, soapRes(`<RetrievePerfCountersResponse xmlns="urn:vim25">${xml}</RetrievePerfCountersResponse>`));
      }

      if (body.includes("QueryAvailablePerfMetric")) {
        // Basitlik için: TÜM entity'lerde 4 sayacın da (cpu/mem/disk/net) mevcut
        // olduğunu varsayıyoruz -- gerçek VMware'de entity tipine göre değişebilir.
        const xml = [2, 24, 100, 200].map((id) => `<returnval><counterId>${id}</counterId><instance></instance></returnval>`).join("");
        return sendXml(200, soapRes(`<QueryAvailablePerfMetricResponse xmlns="urn:vim25">${xml}</QueryAvailablePerfMetricResponse>`));
      }

      if (body.includes("QueryPerf")) {
        const entityMatch = body.match(/<(?:\w+:)?entity[^>]*>(.*?)<\/(?:\w+:)?entity>/);
        const entityId = entityMatch?.[1] || "unknown";
        const counterIdMatches = [...body.matchAll(/<(?:\w+:)?counterId>(\d+)<\/(?:\w+:)?counterId>/g)].map((m) => Number(m[1]));
        // Deterministik-benzeri (entity+counter'a bağlı) sahte değerler --
        // gerçek bir dalgalanma hissi versin diye küçük bir rastgelelik eklendi.
        const seed = entityId.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
        const valueFor = (counterId) => {
          const base = { 2: 45, 24: 55, 100: 500, 200: 1200 }[counterId] || 10;
          return Math.max(0, Math.round(base + ((seed * counterId) % 40) - 20));
        };
        const values = counterIdMatches.map((cid) => `<value><id><counterId>${cid}</counterId><instance></instance></id><value>${valueFor(cid)}</value></value>`).join("");
        return sendXml(200, soapRes(
          `<QueryPerfResponse xmlns="urn:vim25"><returnval>` +
          `<entity type="unknown">${entityId}</entity>` +
          `<sampleInfo><interval>20</interval><timestamp>${new Date().toISOString()}</timestamp></sampleInfo>` +
          values +
          `</returnval></QueryPerfResponse>`
        ));
      }

      if (body.includes("Logout")) {
        return sendXml(200, soapRes(`<LogoutResponse xmlns="urn:vim25"/>`));
      }

      return sendXml(500, soapRes(`<soapenv:Fault><faultstring>UnknownMethod</faultstring></soapenv:Fault>`));
    });
    return;
  }


});

server.listen(PORT, () => console.log(`[MockVCenter] Sahte vCenter API dinliyor: ${PORT} (kullanıcı: ${VALID_USER})`));
