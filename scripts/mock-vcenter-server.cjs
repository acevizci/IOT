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

// 20 sahte VM -- bazıları açık, bazıları kapalı (gerçekçi çeşitlilik için)
const VMS = Array.from({ length: 20 }, (_, i) => ({
  vm: `vm-${1000 + i}`,
  name: `test-vm-${String(i).padStart(2, "0")}`,
  power_state: i % 7 === 0 ? "POWERED_OFF" : (i % 11 === 0 ? "SUSPENDED" : "POWERED_ON"),
  cpu_count: [2, 4, 8][i % 3],
  memory_size_MiB: [2048, 4096, 8192, 16384][i % 4]
}));

const HOSTS = [
  { host: "host-1", name: "esxi-01.lab.local", connection_state: "CONNECTED", power_state: "POWERED_ON" },
  { host: "host-2", name: "esxi-02.lab.local", connection_state: "CONNECTED", power_state: "POWERED_ON" }
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

  send(res, 404, { type: "com.vmware.vapi.std.errors.not_found", messages: [{ default_message: "Bulunamadı" }] });
});

server.listen(PORT, () => console.log(`[MockVCenter] Sahte vCenter API dinliyor: ${PORT} (kullanıcı: ${VALID_USER})`));
