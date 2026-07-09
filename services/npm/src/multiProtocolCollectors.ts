import ping from "ping";
import net from "net";
import type { EffectiveItem } from "./effectiveItems.js";
import type { DeviceRow } from "./db.js";
import { publishMetric } from "./redisClient.js";

// ============ ICMP PING ============
// connection_config: {} (item'ın kendisi cihazın IP'sini kullanır, ek config gerekmez)
async function pollIcmpPing(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<void> {
  try {
    const result = await ping.promise.probe(device.ip_address, { timeout: 3 });
    const value = result.alive ? (parseFloat(result.time as any) || 0) : -1;

    await publishMetric({
      event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
      metric_name: item.metric_name, timestamp, value, unit: item.unit || "ms"
    });
    console.log(`[Ping] ${device.name}: ${result.alive ? `${value}ms` : "yanıt yok"}`);
  } catch (err: any) {
    console.log(`[Ping] ${device.name} hata: ${err.message}`);
  }
}

// ============ TCP PORT KONTROLÜ ============
// connection_config: { "port": 5432 }
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

async function pollTcpPort(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<void> {
  const port = item.connection_config?.port;
  if (!port) {
    console.log(`[TCP-Port] ${device.name} ${item.metric_name}: connection_config.port tanımlı değil`);
    return;
  }

  const isOpen = await checkTcpPort(device.ip_address, Number(port));
  await publishMetric({
    event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
    metric_name: item.metric_name, timestamp, value: isOpen ? 1 : 0, unit: "status"
  });
  console.log(`[TCP-Port] ${device.name}:${port} → ${item.metric_name} = ${isOpen ? "açık" : "kapalı"}`);
}

// ============ HTTP/JSON ============
// connection_config: { "url": "http://...", "json_path": "data.value", "method": "GET" }
function readJsonPath(obj: any, path: string): any {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

async function pollHttpJson(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<void> {
  const url = item.connection_config?.url;
  const jsonPath = item.connection_config?.json_path;
  const method = item.connection_config?.method || "GET";

  if (!url) {
    console.log(`[HTTP-JSON] ${device.name} ${item.metric_name}: connection_config.url tanımlı değil`);
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, { method, signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      console.log(`[HTTP-JSON] ${device.name} ${item.metric_name}: HTTP ${response.status}`);
      return;
    }

    const body = await response.json();
    const rawValue = jsonPath ? readJsonPath(body, jsonPath) : body;
    const value = Number(rawValue);

    if (Number.isNaN(value)) {
      console.log(`[HTTP-JSON] ${device.name} ${item.metric_name}: değer sayı değil (${rawValue})`);
      return;
    }

    await publishMetric({
      event_type: "metric", source_module: "npm", tenant_id: device.tenant_id, device_id: device.id,
      metric_name: item.metric_name, timestamp, value, unit: item.unit || undefined
    });
    console.log(`[HTTP-JSON] ${device.name}: ${item.metric_name} = ${value}`);
  } catch (err: any) {
    console.log(`[HTTP-JSON] ${device.name} ${item.metric_name} hata: ${err.message}`);
  }
}

// ============ DAĞITICI ============
export async function pollMultiProtocolItem(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<void> {
  switch (item.collector_type) {
    case "icmp_ping":
      return pollIcmpPing(device, item, timestamp);
    case "tcp_port":
      return pollTcpPort(device, item, timestamp);
    case "http_json":
      return pollHttpJson(device, item, timestamp);
    default:
      // 'snmp' ve formül tabanlı item'lar zaten snmpPoller.ts'te işleniyor
      return;
  }
}

// ============ MASTER / DEPENDENT ITEM ============
// Bir master HTTP item'ının yanıtını TEK SEFERDE çekip, bağımlı (dependent) item'ların
// aynı ham yanıttan JSONPath ile farklı alanlar çıkarmasını sağlar — REST API'lerde
// (Veeam/EMC/Elasticsearch gibi tek çağrıda çok veri dönen kaynaklar) her metrik için
// ayrı ağ isteği atmayı önler (7.2 kritik bulgusu).

function readJsonPathDeep(obj: any, path: string): any {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export async function pollMasterWithDependents(
  masterItem: EffectiveItem,
  dependentItems: EffectiveItem[],
  device: DeviceRow,
  timestamp: string
): Promise<void> {
  const url = masterItem.connection_config?.url;
  if (!url) {
    console.log(`[Master-Item] ${device.name} ${masterItem.metric_name}: url tanımlı değil`);
    return;
  }

  let body: any;
  try {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, { method: masterItem.connection_config?.method || "GET", signal: controller.signal });
    clearTimeout(timeoutHandle);
    if (!response.ok) {
      console.log(`[Master-Item] ${device.name} ${masterItem.metric_name}: HTTP ${response.status}`);
      return;
    }
    body = await response.json();
  } catch (err: any) {
    console.log(`[Master-Item] ${device.name} ${masterItem.metric_name} hata: ${err.message}`);
    return;
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
}
