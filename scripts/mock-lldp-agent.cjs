// Mock LLDP SNMP Agent -- LLDP keşif özelliğini test etmek için GERÇEK bir SNMP
// agent'ı (net-snmp'in createAgent() API'si) çalıştırır, standart LLDP-MIB
// (lldpRemTable) OID'lerine yanıt verir. mock-vcenter-server.cjs deseniyle
// TUTARLI: komut satırı parametreleriyle çalıştırılır, AYNI script iki farklı
// parametre setiyle iki kez başlatılarak "birbirini komşu gören iki sahte switch"
// simüle edilir.
//
// Kullanım: node mock-lldp-agent.cjs <port> <kendiSysName> <kendiYonAdres>
//           <komsuYonAdres> <kendiLokalPort> <komsuUzakPort> <komsuSysName>
//
// BASİTLEŞTİRME (lldpDiscovery.ts ile TUTARLI): gerçek LLDP-MIB'de yönetim adresi
// AYRI bir tabloda (lldpRemManAddrTable) tutulur -- burada basitlik için
// lldpRemChassisId sütununa (normalde MAC adresi taşır) doğrudan komşunun
// yönetim IP'sini yazıyoruz.
const snmp = require("net-snmp");

const [, , portArg, selfSysName, selfManAddr, neighborManAddr, selfLocalPort, neighborRemotePort, neighborSysName] = process.argv;
const port = Number(portArg) || 1162;

const agent = snmp.createAgent({ port, disableAuthorization: true }, (error) => {
  if (error) {
    console.error(`[MockLLDP:${port}] Agent başlatma hatası:`, error);
    process.exit(1);
  }
});

const mib = agent.getMib();

// Temel sysDescr/sysName (isteğe bağlı ama gerçekçilik için)
mib.registerProvider({
  name: "sysName",
  type: snmp.MibProviderType.Scalar,
  oid: "1.3.6.1.2.1.1.5",
  scalarType: snmp.ObjectType.OctetString,
  maxAccess: snmp.MaxAccess["read-only"]
});
mib.setScalarValue("sysName", selfSysName || `mock-switch-${port}`);

// lldpRemTable (OID: 1.0.8802.1.1.2.1.4.1.1) -- "entry" OID'i, tablo OID'i değil.
mib.registerProvider({
  name: "lldpRemTable",
  type: snmp.MibProviderType.Table,
  oid: "1.0.8802.1.1.2.1.4.1.1",
  maxAccess: snmp.MaxAccess["not-accessible"],
  tableColumns: [
    { number: 1, name: "lldpRemTimeMark", type: snmp.ObjectType.TimeTicks, maxAccess: snmp.MaxAccess["read-only"] },
    { number: 2, name: "lldpRemLocalPortNum", type: snmp.ObjectType.Integer, maxAccess: snmp.MaxAccess["read-only"] },
    { number: 3, name: "lldpRemIndex", type: snmp.ObjectType.Integer, maxAccess: snmp.MaxAccess["read-only"] },
    { number: 4, name: "lldpRemChassisIdSubtype", type: snmp.ObjectType.Integer, maxAccess: snmp.MaxAccess["read-only"] },
    { number: 5, name: "lldpRemChassisId", type: snmp.ObjectType.OctetString, maxAccess: snmp.MaxAccess["read-only"] },
    { number: 6, name: "lldpRemPortIdSubtype", type: snmp.ObjectType.Integer, maxAccess: snmp.MaxAccess["read-only"] },
    { number: 7, name: "lldpRemPortId", type: snmp.ObjectType.OctetString, maxAccess: snmp.MaxAccess["read-only"] },
    { number: 8, name: "lldpRemPortDesc", type: snmp.ObjectType.OctetString, maxAccess: snmp.MaxAccess["read-only"] },
    { number: 9, name: "lldpRemSysName", type: snmp.ObjectType.OctetString, maxAccess: snmp.MaxAccess["read-only"] }
  ],
  tableIndex: [
    { columnName: "lldpRemTimeMark" },
    { columnName: "lldpRemLocalPortNum" },
    { columnName: "lldpRemIndex" }
  ]
});

// Tek satır: bu "switch", tek bir komşu görüyor (kendi lokal portundan, komşunun
// uzak portuna bağlı). timeMark=0, localPortNum=1 (sabit port numarası), remIndex=1.
mib.addTableRow("lldpRemTable", [
  0,                          // lldpRemTimeMark
  1,                          // lldpRemLocalPortNum (sabit, tek port simüle ediyoruz)
  1,                          // lldpRemIndex
  4,                          // lldpRemChassisIdSubtype (4 = macAddress, standart değer)
  neighborManAddr || "",      // lldpRemChassisId -- BASİTLEŞTİRME: komşunun yönetim IP'si
  5,                          // lldpRemPortIdSubtype (5 = interfaceName, standart değer)
  neighborRemotePort || "",  // lldpRemPortId
  `Port ${neighborRemotePort || ""}`, // lldpRemPortDesc
  neighborSysName || ""       // lldpRemSysName
]);

console.log(`[MockLLDP:${port}] Hazır -- kendi=${selfSysName}(${selfManAddr}), komşu=${neighborSysName}(${neighborManAddr}) local_port=${selfLocalPort} remote_port=${neighborRemotePort}`);
