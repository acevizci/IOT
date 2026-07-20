import snmp from "net-snmp";
import { pool } from "./db.js";
import { publishMetric } from "./redisClient.js";

// SNMP Trap Alıcısı (Adım: en büyük eksik collector -- kullanıcı isteği). Önceki
// TÜM collector'lar AKTİF sorgulama yapıyordu (biz cihaza SORUYORUZ) -- traps ise
// PASİF, cihazın KENDİSİNİN bize GÖNDERDİĞİ, beklenmedik (unsolicited) olaylardır.
// Birçok cihaz (UPS, disk array, switch) önemli olayları (güç kesintisi, disk
// arızası, link down) SADECE trap ile bildirir -- polling ile HİÇ yakalanamaz.
//
// TASARIM: her trap, kaynak IP'sine göre devices tablosuyla eşleştirilir (LLDP'deki
// aynı desen), sonra tek bir "snmp_trap" metriği olarak yayınlanır -- instance_label
// trap'in TÜRÜNÜ (örn. "linkDown") taşır, böylece aynı cihazdan gelen FARKLI trap
// türleri ayrı ayrı izlenip alarm kuralı tanımlanabilir (VMware/servis izleme
// desenleriyle tutarlı). Eşleşen bir cihaz bulunamazsa (bilinmeyen kaynak) sadece
// loglanır, hataya düşülmez -- trap'ler HERKESTEN gelebilir, sadece izlediğimiz
// cihazlar için anlamlıdır.

// RFC 1907'nin standart "generic trap" OID'leri (snmpTrapOID.0 değeri olarak gelir) --
// bunları insan-okunabilir isimlere çeviriyoruz. Bilinmeyen (vendor-specific) OID'ler
// ham OID string'i olarak kullanılır.
const STANDARD_TRAP_NAMES: Record<string, string> = {
  "1.3.6.1.6.3.1.1.5.1": "coldStart",
  "1.3.6.1.6.3.1.1.5.2": "warmStart",
  "1.3.6.1.6.3.1.1.5.3": "linkDown",
  "1.3.6.1.6.3.1.1.5.4": "linkUp",
  "1.3.6.1.6.3.1.1.5.5": "authenticationFailure",
  "1.3.6.1.6.3.1.1.5.6": "egpNeighborLoss"
};
const SNMP_TRAP_OID_VARBIND = "1.3.6.1.6.3.1.1.4.1.0"; // snmpTrapOID.0

let receiver: any = null;

export function startTrapReceiver() {
  const port = Number(process.env.SNMP_TRAP_PORT) || 1162; // gerçek 162 admin yetkisi ister
  receiver = snmp.createReceiver({ port, disableAuthorization: true }, async (error: any, notification: any) => {
    if (error) {
      console.error("[SNMP-Trap] Alım hatası:", error);
      return;
    }
    try {
      await handleTrap(notification);
    } catch (err) {
      console.error("[SNMP-Trap] İşleme hatası:", err);
    }
  });
  console.log(`[SNMP-Trap] Alıcı hazır: UDP ${port}`);
}

async function handleTrap(notification: any) {
  const sourceIp = notification.rinfo?.address;
  if (!sourceIp) return;

  const varbinds: Array<{ oid: string; value: any }> = notification.pdu?.varbinds || [];
  const trapOidVarbind = varbinds.find((v) => v.oid === SNMP_TRAP_OID_VARBIND);
  const trapOid = trapOidVarbind?.value?.toString() || "unknown";
  const trapName = STANDARD_TRAP_NAMES[trapOid] || trapOid;

  // Kaynak IP'yi devices tablosuyla eşleştir (LLDP keşfindeki AYNI desen) --
  // hem device_interfaces (snmp interface) hem devices.ip_address'e bakılıyor.
  const deviceResult = await pool.query(
    `SELECT d.id, d.tenant_id, d.name
     FROM devices d
     LEFT JOIN device_interfaces di ON di.device_id = d.id AND di.interface_type = 'snmp'
     WHERE COALESCE(di.ip_address, host(d.ip_address)) = $1
     LIMIT 1`,
    [sourceIp]
  );
  if (deviceResult.rows.length === 0) {
    console.log(`[SNMP-Trap] Bilinmeyen kaynaktan trap (${sourceIp}): ${trapName} -- göz ardı edildi`);
    return;
  }
  const device = deviceResult.rows[0];
  console.log(`[SNMP-Trap] ${device.name}: ${trapName} trap alındı (${sourceIp})`);

  await publishMetric({
    event_type: "metric",
    source_module: "npm",
    tenant_id: device.tenant_id,
    device_id: device.id,
    metric_name: "snmp_trap",
    timestamp: new Date().toISOString(),
    value: 1,
    tags: { instance_label: trapName, trap_oid: trapOid }
  });
}

export function stopTrapReceiver() {
  receiver?.close();
}
