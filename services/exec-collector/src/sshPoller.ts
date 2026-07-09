import { Client } from "ssh2";
import { publishMetric } from "./redisClient.js";
import { fetchCredential, fetchDeviceSshConfig } from "./coreClient.js";
import type { DeviceRow, EffectiveItem } from "./coreClient.js";

function runSshCommand(
  host: string,
  port: number,
  username: string,
  authType: "ssh_password" | "ssh_key",
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
    if (authType === "ssh_password") {
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

export async function pollSshItem(device: DeviceRow, item: EffectiveItem, timestamp: string): Promise<void> {
  const itemConfig = item.connection_config; // sadece "ne toplanacağı": command, parse_pattern
  if (!itemConfig?.command) {
    console.log(`[SSH] ${device.name} ${item.metric_name}: command tanımlı değil`);
    return;
  }

  // Bağlantı bilgisi (port, credential) cihazın kendi config'inden gelir — host, SNMP'de olduğu
  // gibi cihazın kendi ip_address'i, template item'a hiç bağlantı bilgisi gömülmez.
  const sshConfig = await fetchDeviceSshConfig(device.id);
  if (!sshConfig?.credential_id) {
    console.log(`[SSH] ${device.name} ${item.metric_name}: cihaz için SSH bağlantı ayarı tanımlanmamış (Device Detail > Bağlantı Ayarları)`);
    return;
  }

  const credential = await fetchCredential(sshConfig.credential_id);
  if (!credential) {
    console.log(`[SSH] ${device.name} ${item.metric_name}: kimlik bilgisi bulunamadı`);
    return;
  }

  try {
    const output = await runSshCommand(
      device.ip_address,
      sshConfig.port || 22,
      credential.username,
      credential.credential_type,
      credential.secret,
      itemConfig.command
    );

    const value = extractValue(output, itemConfig.parse_pattern);
    if (value === null) {
      console.log(`[SSH] ${device.name} ${item.metric_name}: çıktıdan sayı çıkarılamadı ("${output.trim().slice(0, 80)}")`);
      return;
    }

    await publishMetric({
      event_type: "metric", source_module: "exec-collector", tenant_id: device.tenant_id, device_id: device.id,
      metric_name: item.metric_name, timestamp, value, unit: item.unit || undefined
    });
    console.log(`[SSH] ${device.name}: ${item.metric_name} = ${value}`);
  } catch (err: any) {
    console.log(`[SSH] ${device.name} ${item.metric_name} hata: ${err.message}`);
  }
}
