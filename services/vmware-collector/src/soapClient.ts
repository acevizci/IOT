// vSphere Web Services API (VIM25, SOAP) istemcisi -- SADECE PerformanceManager alt
// kümesi. Bu, REST API'nin (vsphereClient.ts) KAPSAMADIĞI gerçek CPU/RAM/disk KULLANIM
// yüzdelerini sağlıyor. GERÇEK bir vCenter'a karşı test EDİLEMEDİ (bu ortamda erişim
// yok) -- scripts/mock-vcenter-server.cjs'in /sdk endpoint'iyle uçtan uca test edildi.
//
// ÜÇ AŞAMALI MODEL (VMware'in kendi tasarımı, kısayol YOK): counterId'ler vCenter
// kurulumuna göre DEĞİŞİR (asla sabit kodlanmaz) -- önce sayaç kataloğu çekilip
// (fetchPerfCounters, oturum başına BİR KEZ, cache'lenir), group+name ile ARANIR,
// sonra QueryPerf'e o counterId'ler verilir.

interface PerfCounterInfo {
  id: number;
  group: string;
  name: string;
  unit: string;
}

// TEST AMAÇLI KAÇIŞ KAPISI: gerçek vCenter/ESXi HER ZAMAN HTTPS kullanır -- bu SADECE
// mock-vcenter-server.cjs'e (düz HTTP dinliyor) bağlanabilmek için var. Üretimde bu
// env değişkeni HİÇ set edilmemeli (vsphereClient.ts'teki AYNI kaçış kapısı).
const USE_HTTP_FOR_TESTING = process.env.VMWARE_MOCK_HTTP === "true";

function xmlTag(body: string, tag: string): string | undefined {
  const match = body.match(new RegExp(`<${tag}>(.*?)<\\/${tag}>`));
  return match?.[1];
}

export class SoapPerfClient {
  private baseUrl: string;
  private sessionCookie: string | null = null;
  private counterCache: PerfCounterInfo[] | null = null;

  constructor(host: string, port: number) {
    const protocol = USE_HTTP_FOR_TESTING ? "http" : "https";
    this.baseUrl = `${protocol}://${host}:${port}`;
  }

  private async soapCall(bodyXml: string): Promise<string> {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:vim25="urn:vim25"><soapenv:Body>${bodyXml}</soapenv:Body></soapenv:Envelope>`;
    const headers: Record<string, string> = { "Content-Type": "text/xml; charset=utf-8" };
    if (this.sessionCookie) headers["Cookie"] = this.sessionCookie;

    const response = await fetch(`${this.baseUrl}/sdk`, { method: "POST", headers, body: envelope });
    const text = await response.text();
    if (!response.ok) throw new Error(`SOAP çağrısı başarısız (HTTP ${response.status}): ${text.slice(0, 200)}`);
    if (text.includes("<soapenv:Fault>")) throw new Error(`SOAP Fault: ${xmlTag(text, "faultstring") || "bilinmeyen hata"}`);

    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.sessionCookie = setCookie.split(";")[0];

    return text;
  }

  async login(username: string, password: string): Promise<void> {
    // RetrieveServiceContent oturum GEREKTİRMEZ (gerçek VMware'de de öyle) --
    // sadece SessionManager/PerformanceManager'ın MoRef'lerini keşfetmek için.
    await this.soapCall(`<vim25:RetrieveServiceContent><vim25:_this type="ServiceInstance">ServiceInstance</vim25:_this></vim25:RetrieveServiceContent>`);
    await this.soapCall(
      `<vim25:Login><vim25:_this type="SessionManager">SessionManager</vim25:_this><vim25:userName>${username}</vim25:userName><vim25:password>${password}</vim25:password></vim25:Login>`
    );
  }

  async logout(): Promise<void> {
    if (!this.sessionCookie) return;
    try {
      await this.soapCall(`<vim25:Logout><vim25:_this type="SessionManager">SessionManager</vim25:_this></vim25:Logout>`);
    } catch {
      // Logout hatası kritik değil -- oturumlar zaten sunucu tarafında zaman aşımına uğrar.
    } finally {
      this.sessionCookie = null;
    }
  }

  // Sayaç kataloğu -- oturum başına BİR KEZ çekilip cache'lenir (her VM/host için
  // tekrar tekrar sorgulamak gereksiz -- kataloğun kendisi entity'den BAĞIMSIZDIR).
  private async fetchPerfCounters(): Promise<PerfCounterInfo[]> {
    if (this.counterCache) return this.counterCache;
    const xml = await this.soapCall(`<vim25:RetrievePerfCounters><vim25:_this type="PerformanceManager">PerfManager</vim25:_this></vim25:RetrievePerfCounters>`);
    const counters: PerfCounterInfo[] = [];
    const blocks = xml.match(/<returnval>.*?<\/returnval>/gs) || [];
    for (const block of blocks) {
      const id = xmlTag(block, "key");
      const group = block.match(/<groupInfo><key>(.*?)<\/key><\/groupInfo>/)?.[1];
      const name = block.match(/<nameInfo><key>(.*?)<\/key><\/nameInfo>/)?.[1];
      const unit = block.match(/<unitInfo><key>(.*?)<\/key><\/unitInfo>/)?.[1];
      if (id && group && name) counters.push({ id: Number(id), group, name, unit: unit || "" });
    }
    this.counterCache = counters;
    return counters;
  }

  // Belirli bir entity (VM/host) için, verilen "group.name" listesine (örn.
  // ["cpu.usage", "mem.usage"]) karşılık gelen GERÇEK counterId'leri bulup
  // QueryPerf ile en son değerleri çeker. Bulunamayan sayaçlar sessizce atlanır
  // (sonuç objesinde o anahtar hiç olmaz) -- entity tipi o sayacı desteklemiyor
  // olabilir, bu bir hata değildir.
  async queryLatestMetrics(entityType: string, entityId: string, wantedMetrics: string[]): Promise<Record<string, number>> {
    const counters = await this.fetchPerfCounters();
    const wanted = new Map<number, string>(); // counterId -> "group.name"
    for (const m of wantedMetrics) {
      const [group, name] = m.split(".");
      const found = counters.find((c) => c.group === group && c.name === name);
      if (found) wanted.set(found.id, m);
    }
    if (wanted.size === 0) return {};

    const metricIdXml = Array.from(wanted.keys())
      .map((cid) => `<vim25:metricId><vim25:counterId>${cid}</vim25:counterId><vim25:instance></vim25:instance></vim25:metricId>`)
      .join("");
    const xml = await this.soapCall(
      `<vim25:QueryPerf><vim25:_this type="PerformanceManager">PerfManager</vim25:_this>` +
      `<vim25:querySpec><vim25:entity type="${entityType}">${entityId}</vim25:entity>${metricIdXml}<vim25:intervalId>20</vim25:intervalId><vim25:maxSample>1</vim25:maxSample><vim25:format>normal</vim25:format></vim25:querySpec>` +
      `</vim25:QueryPerf>`
    );

    const results: Record<string, number> = {};
    // Her "counterId + değer" çiftini TEK regex ile eşleştir -- iç içe <value>
    // etiketleriyle (dış <value>...</value> İÇİNDE bir <value>SAYI</value> daha
    // var) ayrı ayrı uğraşmak kırılgan olurdu.
    const pairPattern = /<counterId>(\d+)<\/counterId><instance><\/instance><\/id><value>([\d.-]+)<\/value>/g;
    for (const match of xml.matchAll(pairPattern)) {
      const counterId = Number(match[1]);
      if (wanted.has(counterId)) results[wanted.get(counterId)!] = Number(match[2]);
    }
    return results;
  }
}
