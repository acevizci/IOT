import snmp from "net-snmp";

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

export function discoverDevice(ipAddress: string, community: string, port = 161): Promise<DiscoveryResult> {
  return new Promise((resolve) => {
    const session = snmp.createSession(ipAddress, community, {
      port,
      timeout: 4000,
      retries: 1,
      version: snmp.Version2c
    });

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
