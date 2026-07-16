import { Client } from "ssh2";
import { publishMetric } from "./redisClient.js";
import { fetchResolvedConfig, reportCollectorStatus } from "./coreClient.js";
import type { DeviceRow, EffectiveItem } from "./coreClient.js";

export function runSshCommand(
  host: string,
  port: number,
  username: string,
  authType: "password" | "key",
  secret: string,
  command: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timeout = setTimeout(() => {
      conn.end();
      reject(new Error("SSH bağlantı zaman aşımı"));
    }, 8000);

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          conn.end();
          return reject(err);
        }
        let output = "";
        stream.on("data", (data: Buffer) => { output += data.toString(); });
        stream.on("close", () => {
          clearTimeout(timeout);
          conn.end();
          resolve(output);
        });
        stream.stderr.on("data", () => {}); // stderr'i yut, sadece stdout'u kullan
      });
    });

    conn.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    const connectConfig: any = { host, port, username, readyTimeout: 6000 };
    if (authType === "password") {
      connectConfig.password = secret;
    } else {
      connectConfig.privateKey = secret;
    }
    conn.connect(connectConfig);
  });
}

// Çıktıdan sayısal değeri çıkarma: parse_pattern verilmişse regex ile ilk yakalama grubu,
// verilmemişse çıktının son dolu satırının trim'lenmiş hali (en öngörülebilir, en az hataya açık varsayılan).
function extractValue(output: string, parsePattern?: string): number | null {
  let raw: string;

  if (parsePattern) {
    const match = output.match(new RegExp(parsePattern));
    if (!match || !match[1]) return null;
    raw = match[1];
  } else {
    const lines = output.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    raw = lines[lines.length - 1] || "";
  }

  const value = Number(raw);
  return Number.isNaN(value) ? null : value;
}

// Faz Queue-audit: HER erken-cikis noktasi ve catch bloğu, artik dönüş değeri olarak
// bir hata mesajı (string) verir -- öncesinde bu hatalar sadece console.log'a
// yazılıp yutuluyordu, Queue Details'teki last_error sütunu hiçbir zaman dolmazdı.
export async function pollSshItem(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<string | undefined> {
  const itemConfig = item.connection_config;
  if (!itemConfig?.command) {
    const msg = "command tanımlı değil";
    console.log(`[SSH] ${device.name} ${item.metric_name}: ${msg}`);
    return msg;
  }

  // connection_config içindeki {$SSH_PORT}/{$SSH_USER}/{$SSH_PASSWORD} gibi makro referanslarını
  // bu cihaz için çözer (device/grup override > tenant varsayılanı önceliğiyle). host hâlâ
  // device.ip_address'ten gelir — SNMP'nin zaten yaptığı gibi, makro sistemine hiç girmez.
  const resolved = await fetchResolvedConfig(device.id, itemConfig);
  if (!resolved) {
    const msg = "bağlantı bilgisi çözülemedi (Core Service'e ulaşılamadı)";
    console.log(`[SSH] ${device.name} ${item.metric_name}: ${msg}`);
    return msg;
  }

  const username: string | undefined = resolved.username;
  const secret: string | undefined = resolved.password ?? resolved.secret;
  if (!username || !secret) {
    const msg = "SSH bağlantı bilgisi eksik — {$SSH_USER}/{$SSH_PASSWORD} bu cihaz için ayarlanmamış";
    console.log(`[SSH] ${device.name} ${item.metric_name}: ${msg}`);
    return msg;
  }

  const port = Number(resolved.port) || 22;
  const authType: "password" | "key" = resolved.auth_type === "key" || resolved.auth_type === "ssh_key" ? "key" : "password";

  try {
    const output = await runSshCommand(device.ip_address, port, username, authType, secret, itemConfig.command);

    const value = extractValue(output, itemConfig.parse_pattern);
    if (value === null) {
      const msg = `çıktıdan sayı çıkarılamadı ("${output.trim().slice(0, 80)}")`;
      console.log(`[SSH] ${device.name} ${item.metric_name}: ${msg}`);
      return msg;
    }

    await publishMetric({
      event_type: "metric", source_module: "exec-collector", tenant_id: device.tenant_id, device_id: device.id,
      metric_name: item.metric_name, timestamp, value, unit: item.unit || undefined
    });
    console.log(`[SSH] ${device.name}: ${item.metric_name} = ${value}`);
    await reportCollectorStatus(device.id, "active");
    return undefined;
  } catch (err: any) {
    console.log(`[SSH] ${device.name} ${item.metric_name} hata: ${err.message}`);
    await reportCollectorStatus(device.id, "down", err.message);
    return err.message;
  }
}
