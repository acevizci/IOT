import ping from "ping";
import net from "net";
import tls from "tls";
import type { EffectiveItem } from "./effectiveItems.js";
import type { DeviceRow } from "./db.js";
import { publishMetric } from "./redisClient.js";

// Faz Queue-audit: her fonksiyon artik bir hata mesaji (string) donduruyor --
// oncesinde sadece console.log'a yazilip yutuluyordu, Queue Details'teki
// last_error sutunu hicbir zaman dolmuyordu.

// ============ ICMP PING ============
async function pollIcmpPing(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<string | undefined> {
  try {
    const result = await ping.promise.probe(device.ip_address, { timeout: 3 });
    const value = result.alive ? (parseFloat(result.time as any) || 0) : -1;

    await publishMetric({
      event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
      metric_name: item.metric_name, timestamp, value, unit: item.unit || "ms"
    });
    console.log(`[Ping] ${device.name}: ${result.alive ? `${value}ms` : "yanıt yok"}`);
    return result.alive ? undefined : "yanıt yok";
  } catch (err: any) {
    console.log(`[Ping] ${device.name} hata: ${err.message}`);
    return err.message;
  }
}

// ============ TCP PORT KONTROLÜ ============
function checkTcpPort(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    socket.setTimeout(timeoutMs);
    socket.on("connect", () => { resolved = true; socket.destroy(); resolve(true); });
    socket.on("timeout", () => { if (!resolved) { socket.destroy(); resolve(false); } });
    socket.on("error", () => { if (!resolved) resolve(false); });

    socket.connect(port, host);
  });
}

async function pollTcpPort(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<string | undefined> {
  const port = item.connection_config?.port;
  if (!port) {
    const msg = "connection_config.port tanımlı değil";
    console.log(`[TCP-Port] ${device.name} ${item.metric_name}: ${msg}`);
    return msg;
  }

  const isOpen = await checkTcpPort(device.ip_address, Number(port));
  await publishMetric({
    event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
    metric_name: item.metric_name, timestamp, value: isOpen ? 1 : 0, unit: "status"
  });
  console.log(`[TCP-Port] ${device.name}:${port} → ${item.metric_name} = ${isOpen ? "açık" : "kapalı"}`);
  return isOpen ? undefined : `port ${port} kapalı/erişilemez`;
}

// ============ HTTP/JSON ============
function readJsonPath(obj: any, path: string): any {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

async function pollHttpJson(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<string | undefined> {
  const url = item.connection_config?.url;
  const jsonPath = item.connection_config?.json_path;
  const method = item.connection_config?.method || "GET";

  if (!url) {
    const msg = "connection_config.url tanımlı değil";
    console.log(`[HTTP-JSON] ${device.name} ${item.metric_name}: ${msg}`);
    return msg;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, { method, signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      const msg = `HTTP ${response.status}`;
      console.log(`[HTTP-JSON] ${device.name} ${item.metric_name}: ${msg}`);
      return msg;
    }

    const body = await response.json();
    const rawValue = jsonPath ? readJsonPath(body, jsonPath) : body;
    const value = Number(rawValue);

    if (Number.isNaN(value)) {
      const msg = `değer sayı değil (${rawValue})`;
      console.log(`[HTTP-JSON] ${device.name} ${item.metric_name}: ${msg}`);
      return msg;
    }

    await publishMetric({
      event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
      metric_name: item.metric_name, timestamp, value, unit: item.unit || undefined
    });
    console.log(`[HTTP-JSON] ${device.name}: ${item.metric_name} = ${value}`);
    return undefined;
  } catch (err: any) {
    console.log(`[HTTP-JSON] ${device.name} ${item.metric_name} hata: ${err.message}`);
    return err.message;
  }
}

// ============ SERTİFİKA SÜRE SONU (TLS) ============
// Hedefe TLS ile bağlanıp sunulan sertifikanın notAfter (valid_to) tarihini okur.
// rejectUnauthorized: false ZORUNLU -- amaç zaten süresi geçmiş/self-signed/zincir
// hatalı sertifikaları da inceleyebilmek; doğrulama açık olsaydı handshake bu tür
// sertifikalarda reddedilir, hiç sertifika okuyamazdık.
type CertResult = { validTo: string } | { error: string };

function fetchPeerCert(host: string, port: number, servername: string | undefined, timeoutMs = 5000): Promise<CertResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: CertResult) => { if (!settled) { settled = true; resolve(r); } };

    // servername (SNI) verilmişse gönderilir; verilmemişse (IP hedefi vb.) hiç SNI
    // gönderilmez ve sunucu varsayılan sertifikasını döner.
    const socket = tls.connect(
      { host, port, servername, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        // getPeerCertificate(): handshake tamamlanınca sunucunun sertifikası.
        const cert = socket.getPeerCertificate();
        socket.destroy();
        if (!cert || !cert.valid_to) { finish({ error: "sertifika alınamadı" }); return; }
        finish({ validTo: cert.valid_to });
      }
    );

    socket.on("timeout", () => { socket.destroy(); finish({ error: "zaman aşımı" }); });
    socket.on("error", (err: any) => { socket.destroy(); finish({ error: err.message }); });
  });
}

async function pollCertExpiry(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<string | undefined> {
  const port = Number(item.connection_config?.port) || 443;
  const servername = item.connection_config?.servername || undefined;
  // İkinci metrik: aynı cihazda birden fazla cert item'ı (443/8443) çakışmasın diye
  // ana metrik adından TÜRETİLİR (sabit 'cert_reachable' değil).
  const reachableMetric = `${item.metric_name}_reachable`;

  const result = await fetchPeerCert(device.ip_address, port, servername, 5000);

  if ("error" in result) {
    // Handshake/bağlantı başarısız -> erişilemez (reachable=0). Kalan gün HESAPLANAMAZ,
    // yayınlanmaz (yanıltıcı olurdu). Hata Queue'daki last_error'a da yansır.
    await publishMetric({
      event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
      metric_name: reachableMetric, timestamp, value: 0, unit: "status"
    });
    console.log(`[Cert] ${device.name}:${port} erişilemez: ${result.error}`);
    return result.error;
  }

  const validTo = new Date(result.validTo);
  if (Number.isNaN(validTo.getTime())) {
    await publishMetric({
      event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
      metric_name: reachableMetric, timestamp, value: 0, unit: "status"
    });
    const msg = `notAfter ayrıştırılamadı (${result.validTo})`;
    console.log(`[Cert] ${device.name}:${port}: ${msg}`);
    return msg;
  }

  // Kalan gün: negatifse sertifika süresi ZATEN geçmiş -- tek bir 'lt 14' kuralı hem
  // "yakında bitecek" hem "bitmiş" durumunu yakalar.
  const daysRemaining = Math.floor((validTo.getTime() - Date.now()) / 86400000);

  await publishMetric({
    event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
    metric_name: item.metric_name, timestamp, value: daysRemaining, unit: item.unit || "days"
  });
  await publishMetric({
    event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
    metric_name: reachableMetric, timestamp, value: 1, unit: "status"
  });
  console.log(`[Cert] ${device.name}:${port} → ${item.metric_name} = ${daysRemaining} gün (bitiş: ${result.validTo})`);
  return undefined;
}

// ============ DAĞITICI ============
export async function pollMultiProtocolItem(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<string | undefined> {
  switch (item.collector_type) {
    case "icmp_ping":
      return pollIcmpPing(device, item, timestamp);
    case "tcp_port":
      return pollTcpPort(device, item, timestamp);
    case "http_json":
      return pollHttpJson(device, item, timestamp);
    case "cert_expiry":
      return pollCertExpiry(device, item, timestamp);
    default:
      // 'snmp' ve formül tabanlı item'lar zaten snmpPoller.ts'te işleniyor
      return undefined;
  }
}

// ============ MASTER / DEPENDENT ITEM ============
function readJsonPathDeep(obj: any, path: string): any {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

// Not: dependent item'lar item_schedule_state'te hic yok (kendi ag cagrilari yok),
// bu yuzden sadece MASTER'in hata durumunu donduruyoruz -- mark-collected zaten
// sadece masterItem.id icin cagriliyor.
export async function pollMasterWithDependents(
  masterItem: EffectiveItem,
  dependentItems: EffectiveItem[],
  device: DeviceRow,
  timestamp: string
): Promise<string | undefined> {
  const url = masterItem.connection_config?.url;
  if (!url) {
    const msg = "url tanımlı değil";
    console.log(`[Master-Item] ${device.name} ${masterItem.metric_name}: ${msg}`);
    return msg;
  }

  let body: any;
  try {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, { method: masterItem.connection_config?.method || "GET", signal: controller.signal });
    clearTimeout(timeoutHandle);
    if (!response.ok) {
      const msg = `HTTP ${response.status}`;
      console.log(`[Master-Item] ${device.name} ${masterItem.metric_name}: ${msg}`);
      return msg;
    }
    body = await response.json();
  } catch (err: any) {
    console.log(`[Master-Item] ${device.name} ${masterItem.metric_name} hata: ${err.message}`);
    return err.message;
  }

  for (const dep of dependentItems) {
    const jsonPath = dep.connection_config?.json_path;
    const rawValue = jsonPath ? readJsonPathDeep(body, jsonPath) : body;
    const value = Number(rawValue);

    if (Number.isNaN(value)) {
      console.log(`[Master-Item] ${device.name} ${dep.metric_name}: değer sayı değil (${rawValue})`);
      continue;
    }

    await publishMetric({
      event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
      metric_name: dep.metric_name, timestamp, value, unit: dep.unit || undefined
    });
    console.log(`[Master-Item] ${device.name}: ${dep.metric_name} = ${value} (master: ${masterItem.metric_name}, tek istek)`);
  }
  return undefined;
}
