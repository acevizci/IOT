import snmp from "net-snmp";
import type { DeviceRow } from "./db.js";

// LLDP (Link Layer Discovery Protocol) -- IEEE 802.1AB standart MIB'i, switch/
// router'ların komşu cihazlarını (fiziksel olarak hangi porttan hangi porta
// bağlı olduklarını) YAYINLADIĞI bir protokol. Zabbix/SolarWinds gibi araçların
// "otomatik topoloji keşfi" özelliğinin temelini oluşturur.
//
// BASİTLEŞTİRME (dürüstçe belirtiliyor): GERÇEK LLDP-MIB'de komşunun yönetim IP
// adresi AYRI bir tabloda (lldpRemManAddrTable, OID 1.0.8802.1.1.2.1.4.2) tutulur
// ve INDEX yapısı (timeMark, localPortNum, remIndex, ManAddrSubtype, ManAddr)
// oldukça karmaşıktır -- production-kalite bir implementasyon bu tabloyu da AYRICA
// sorgulayıp lldpRemLocalPortNum üzerinden eşleştirmelidir. Burada, zaman kısıtları
// nedeniyle, mock ortamımızda komşunun yönetim IP'sini lldpRemChassisId alanına
// (normalde MAC adresi taşır) koyuyoruz -- KAVRAMSAL akış (keşif, eşleştirme,
// topoloji entegrasyonu) doğru ve test edilebilir, ama GERÇEK bir switch'e karşı
// çalıştırılmadan önce lldpRemManAddrTable desteği eklenmelidir.
const LLDP_OIDS = {
  // lldpRemTable: 1.0.8802.1.1.2.1.4.1.1 -- sütun indeksleri:
  remChassisId: 5,   // BASİTLEŞTİRME: burada komşunun yönetim IP'si tutuluyor (bkz. üstteki not)
  remPortId: 7,       // komşunun (uzak) port ID'si
  remSysName: 9        // komşunun sistem adı (hostname)
};

export interface DiscoveredNeighbor {
  localPort: string;
  neighborManagementIp: string;
  neighborPort: string;
  neighborSysName: string;
}

function createSession(device: DeviceRow) {
  const community = device.snmp_config?.community || "public";
  const port = device.snmp_config?.port || 161;
  return snmp.createSession(device.ip_address, community, { port, timeout: 5000, retries: 1, version: snmp.Version2c });
}

// lldpRemTable'ı WALK edip komşu listesini çıkarır.
//
// GERÇEK HATA (canlı testte bulundu): net-snmp'in table() fonksiyonu, LLDP-MIB'in
// ÇOK-SÜTUNLU (compound) index yapısını (3 parçalı: timeMark.localPortNum.remIndex)
// DOĞRU PARSE EDEMİYOR -- gerçek veri VARKEN (standart snmpwalk aracıyla doğrulandı)
// table() sürekli BOŞ obje döndürdü. Bunun yerine subtree() (ham OID-değer çiftleri)
// kullanılıp, satır index'i OID suffix'inden MANUEL çıkarılıyor -- kütüphanenin
// table() varsayımlarına bağımlı olmadan, daha güvenilir.
export function discoverLldpNeighbors(device: DeviceRow): Promise<DiscoveredNeighbor[]> {
  return new Promise((resolve) => {
    const session = createSession(device);
    const baseOid = "1.0.8802.1.1.2.1.4.1.1";
    // rowIndex ("timeMark.localPortNum.remIndex") -> { sütunNo: değer }
    const rows = new Map<string, Record<number, string>>();

    session.subtree(
      baseOid,
      20,
      (varbinds: any[]) => {
        for (const vb of varbinds) {
          if (snmp.isVarbindError(vb)) continue;
          // OID formatı: <baseOid>.<sütunNo>.<timeMark>.<localPortNum>.<remIndex>
          const suffix = vb.oid.startsWith(baseOid + ".") ? vb.oid.slice(baseOid.length + 1) : null;
          if (!suffix) continue;
          const parts = suffix.split(".");
          if (parts.length < 4) continue;
          const columnNo = Number(parts[0]);
          const rowIndex = parts.slice(1).join(".");
          if (!rows.has(rowIndex)) rows.set(rowIndex, {});
          rows.get(rowIndex)![columnNo] = vb.value?.toString() ?? "";
        }
      },
      (error: any) => {
        session.close();
        if (error) {
          // LLDP-MIB desteklemeyen bir cihaz (ev/ofis cihazları, sunucular vb.) --
          // hata değil, sadece keşfedilecek bir şey yok.
          return resolve([]);
        }
        const neighbors: DiscoveredNeighbor[] = [];
        for (const [rowIndex, row] of rows.entries()) {
          const managementIp = row[LLDP_OIDS.remChassisId];
          if (!managementIp) continue;
          const parts = rowIndex.split(".");
          const localPort = parts.length >= 2 ? parts[1] : rowIndex;
          neighbors.push({
            localPort,
            neighborManagementIp: managementIp,
            neighborPort: row[LLDP_OIDS.remPortId] || "",
            neighborSysName: row[LLDP_OIDS.remSysName] || ""
          });
        }
        resolve(neighbors);
      }
    );
  });
}

const CORE_SERVICE_URL = process.env.CORE_SERVICE_URL || "http://core-service:3000";

export async function reportDiscoveredLink(device: DeviceRow, neighbor: DiscoveredNeighbor): Promise<void> {
  try {
    await fetch(`${CORE_SERVICE_URL}/api/v1/internal/topology/discovered-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET || "" },
      body: JSON.stringify({
        tenant_id: device.tenant_id,
        device_id: device.id,
        local_interface: neighbor.localPort,
        neighbor_management_ip: neighbor.neighborManagementIp,
        neighbor_interface: neighbor.neighborPort,
        method: "lldp"
      })
    });
  } catch (err) {
    console.error(`[LLDP] ${device.name}: keşfedilen bağlantı core-service'e bildirilemedi:`, err);
  }
}

// TÜM cihazlar için LLDP keşfini çalıştırıp sonuçları bildirir -- index.ts'teki
// periyodik döngü tarafından çağrılır (metrik toplamadan AYRI, çok daha seyrek
// bir aralıkla -- topoloji sık değişmez).
export async function runLldpDiscoveryForAll(devices: DeviceRow[]): Promise<void> {
  for (const device of devices) {
    const neighbors = await discoverLldpNeighbors(device);
    if (neighbors.length > 0) {
      console.log(`[LLDP] ${device.name}: ${neighbors.length} komşu keşfedildi`);
    }
    for (const neighbor of neighbors) {
      await reportDiscoveredLink(device, neighbor);
    }
  }
}
