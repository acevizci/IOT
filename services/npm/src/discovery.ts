import snmp from "net-snmp";
import ping from "ping";

const OIDS = {
  sysDescr: "1.3.6.1.2.1.1.1.0",
  sysUpTime: "1.3.6.1.2.1.1.3.0",
  ifTable: "1.3.6.1.2.1.2.2"
};

export interface DiscoveryResult {
  reachable: boolean;
  sysDescr?: string;
  interfaceCount?: number;
  interfaceNames?: string[];
  error?: string;
}

export type SnmpAuthProtocol = "md5" | "sha" | "sha224" | "sha256" | "sha384" | "sha512";
export type SnmpPrivProtocol = "des" | "aes" | "aes256b" | "aes256r";
export type SnmpV3Level = "noAuthNoPriv" | "authNoPriv" | "authPriv";

// Tarama isteğinin taşıdığı SNMP kimlik bilgisi -- v2c (community) veya v3
// (auth+priv). Kurumsal/regüle veri merkezlerinde v1/v2c community string'i
// (düz metin, kimlik doğrulaması yok) yetersiz kalabiliyor; v3 zorunlu olan
// ortamlarda keşif ÖNCEDEN hiç çalışmıyordu.
export interface SnmpCredentials {
  version: "v2c" | "v3";
  community?: string; // version=v2c
  v3?: {
    username: string;
    level: SnmpV3Level;
    authProtocol?: SnmpAuthProtocol;
    authKey?: string;
    privProtocol?: SnmpPrivProtocol;
    privKey?: string;
  };
}

const AUTH_PROTOCOL_MAP: Record<SnmpAuthProtocol, number> = {
  md5: snmp.AuthProtocols.md5,
  sha: snmp.AuthProtocols.sha,
  sha224: snmp.AuthProtocols.sha224,
  sha256: snmp.AuthProtocols.sha256,
  sha384: snmp.AuthProtocols.sha384,
  sha512: snmp.AuthProtocols.sha512
};
const PRIV_PROTOCOL_MAP: Record<SnmpPrivProtocol, number> = {
  des: snmp.PrivProtocols.des,
  aes: snmp.PrivProtocols.aes,
  aes256b: snmp.PrivProtocols.aes256b,
  aes256r: snmp.PrivProtocols.aes256r
};
const LEVEL_MAP: Record<SnmpV3Level, number> = {
  noAuthNoPriv: snmp.SecurityLevel.noAuthNoPriv,
  authNoPriv: snmp.SecurityLevel.authNoPriv,
  authPriv: snmp.SecurityLevel.authPriv
};

function createSnmpSession(ipAddress: string, credentials: SnmpCredentials, port: number) {
  const options = { port, timeout: 4000, retries: 1 };

  if (credentials.version === "v3") {
    if (!credentials.v3) throw new Error("SNMPv3 için kimlik bilgisi (v3 alanı) zorunlu");
    const user: any = { name: credentials.v3.username, level: LEVEL_MAP[credentials.v3.level] };
    if (credentials.v3.authProtocol) {
      user.authProtocol = AUTH_PROTOCOL_MAP[credentials.v3.authProtocol];
      user.authKey = credentials.v3.authKey;
    }
    if (credentials.v3.privProtocol) {
      user.privProtocol = PRIV_PROTOCOL_MAP[credentials.v3.privProtocol];
      user.privKey = credentials.v3.privKey;
    }
    return snmp.createV3Session(ipAddress, user, options);
  }

  return snmp.createSession(ipAddress, credentials.community || "public", { ...options, version: snmp.Version2c });
}

export function discoverDevice(ipAddress: string, credentials: SnmpCredentials, port = 161): Promise<DiscoveryResult> {
  return new Promise((resolve) => {
    let session: any;
    try {
      session = createSnmpSession(ipAddress, credentials, port);
    } catch (err: any) {
      return resolve({ reachable: false, error: err.message || "SNMP oturumu oluşturulamadı" });
    }

    session.get([OIDS.sysDescr], (error: any, varbinds: any[]) => {
      if (error) {
        session.close();
        return resolve({ reachable: false, error: error.message || "Cihaza ulaşılamadı" });
      }

      const sysDescr = varbinds[0]?.value?.toString() || "";

      // sysDescr başarılıysa, interface tablosunu da çekelim
      session.table(OIDS.ifTable, 20, (tableError: any, table: any) => {
        session.close();

        if (tableError) {
          return resolve({ reachable: true, sysDescr, interfaceCount: 0, interfaceNames: [] });
        }

        const interfaceNames: string[] = [];
        for (const ifIndex of Object.keys(table)) {
          const descr = table[ifIndex][2]?.toString(); // ifDescr kolonu
          if (descr) interfaceNames.push(descr);
        }

        resolve({
          reachable: true,
          sysDescr,
          interfaceCount: interfaceNames.length,
          interfaceNames
        });
      });
    });
  });
}

// Hızlı ICMP canlılık kontrolü (nmap/Zabbix'in de yaptığı gibi) -- amaç, boş
// IP'lere SNMP'nin 4sn timeout'unu uygulamaktan kaçınmak (büyük aralıklarda
// çoğu adres boştur, her birine SNMP denemek taramayı dakikalarca sürdürür).
// multiProtocolCollectors.ts'teki icmp_ping item tipiyle AYNI `ping` paketi
// (container'ın busybox ping'ini sarmalıyor, ek bir image/capability
// değişikliği gerekmiyor).
export async function pingHost(ip: string): Promise<boolean> {
  const result = await ping.promise.probe(ip, { timeout: 1 });
  return result.alive;
}
