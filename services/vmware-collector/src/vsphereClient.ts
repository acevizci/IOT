// vSphere Automation API (REST, vCenter 7.0+) istemcisi. Endpoint'ler/header'lar/JSON
// alan adları VMware'in RESMİ, BELGELENMİŞ API şekliyle birebir eşleşecek şekilde
// yazıldı -- ama GERÇEK bir vCenter'a karşı test EDİLEMEDİ (bu ortamda erişim yok).
// scripts/mock-vcenter-server.cjs ile uçtan uca test edildi (bkz. commit mesajı) --
// oturum açma/kapatma, hata yönetimi, veri ayrıştırma doğrulandı. Gerçek bir vCenter'a
// bağlanmadan önce mutlaka canlı bir ortamda smoke test yapılmalı (sürüm farkları --
// 6.7/7.0/8.0 arası küçük şema farkları olabilir).

interface VMwareConnectionConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  tlsSkipVerify: boolean;
}

// TEST AMAÇLI KAÇIŞ KAPISI: gerçek vCenter/ESXi HER ZAMAN HTTPS kullanır -- bu SADECE
// scripts/mock-vcenter-server.cjs'e (düz HTTP dinliyor, kolaylık için) bağlanabilmek
// için var. Üretimde bu env değişkeni HİÇ set edilmemeli (compose dosyasında
// tanımlı DEĞİL, varsayılan olarak https kullanılır).
const USE_HTTP_FOR_TESTING = process.env.VMWARE_MOCK_HTTP === "true";

export interface VSphereVM {
  vm: string;
  name: string;
  power_state: "POWERED_ON" | "POWERED_OFF" | "SUSPENDED";
  cpu_count: number;
  memory_size_MiB: number;
  host?: string; // hangi host'ta çalışıyor (vSphere host MOID) -- hiyerarşi için
}

export interface VSphereHost {
  host: string;
  name: string;
  connection_state: string;
  power_state: string;
  cluster?: string; // hangi cluster'a ait (vSphere cluster MOID), ESXi bağımsız modda yok
}

export interface VSphereDatastore {
  datastore: string;
  name: string;
  type: string;
  free_space: number;
  capacity: number;
}

export interface VSphereCluster {
  cluster: string;
  name: string;
  drs_enabled: boolean;
  ha_enabled: boolean;
}

export class VSphereClient {
  private baseUrl: string;
  private sessionId: string | null = null;
  private _username: string;
  private _password: string;

  constructor(config: VMwareConnectionConfig) {
    const protocol = USE_HTTP_FOR_TESTING ? "http" : "https";
    this.baseUrl = `${protocol}://${config.host}:${config.port}`;
    this._username = config.username;
    this._password = config.password;
  }

  // NOT: Node'un fetch()'i (undici) self-signed sertifika kabul etmek için process
  // genelinde NODE_TLS_REJECT_UNAUTHORIZED=0 gerektirir -- bu, index.ts'te İSTEK
  // BAZINDA değil, SADECE tls_skip_verify=true olan bir cihaza bağlanılırken geçici
  // olarak ayarlanıp hemen geri alınır (bkz. index.ts withTlsSkipVerify()) -- process
  // genelinde kalıcı olarak kapatmak TÜM giden bağlantıları (core-service'e olanlar
  // dahil) etkiler, bu KABUL EDİLEMEZ bir güvenlik riski olurdu.
  async login(): Promise<void> {
    const auth = Buffer.from(`${this._username}:${this._password}`).toString("base64");
    const response = await fetch(`${this.baseUrl}/api/session`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` }
    });
    if (!response.ok) {
      throw new Error(`vSphere oturum açma başarısız: HTTP ${response.status}`);
    }
    // GERÇEK API: body doğrudan tırnaklı bir JSON string ("abc123..."), obje değil.
    this.sessionId = await response.json();
  }

  async logout(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(`${this.baseUrl}/api/session`, {
        method: "DELETE",
        headers: { "vmware-api-session-id": this.sessionId }
      });
    } catch {
      // Logout hatası kritik değil -- oturumlar zaten sunucu tarafında zaman aşımına uğrar.
    } finally {
      this.sessionId = null;
    }
  }

  private async get<T>(path: string): Promise<T> {
    if (!this.sessionId) throw new Error("Önce login() çağrılmalı");
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { "vmware-api-session-id": this.sessionId }
    });
    if (!response.ok) {
      throw new Error(`vSphere API hatası (${path}): HTTP ${response.status}`);
    }
    return await response.json();
  }

  async listVMs(): Promise<VSphereVM[]> {
    // BELİRSİZLİK NOTU: gerçek vSphere REST API'sinde GET /api/vcenter/vm'in temel
    // liste yanıtının `host` alanını İÇERİP İÇERMEDİĞİ sürüme göre değişebilir --
    // bazı sürümlerde bu, ayrı bir GET /api/vcenter/vm/{vm} (detay) çağrısı veya
    // ?filter.hosts= sorgu parametresiyle TERSTEN bulunması gerekebilir. Bu mock,
    // basitlik için `host`u doğrudan liste yanıtına koyuyor -- gerçek bir vCenter'a
    // bağlanırken bu varsayım MUTLAKA doğrulanmalı, gerekirse per-VM detay çağrısına
    // geçilmeli (performans etkisi: 300+ VM için N+1 sorgu riski).
    return this.get<VSphereVM[]>("/api/vcenter/vm");
  }

  async listHosts(): Promise<VSphereHost[]> {
    return this.get<VSphereHost[]>("/api/vcenter/host");
  }

  async listDatastores(): Promise<VSphereDatastore[]> {
    return this.get<VSphereDatastore[]>("/api/vcenter/datastore");
  }

  async listClusters(): Promise<VSphereCluster[]> {
    // ESXi bağımsız modda cluster kavramı yok -- bu uç noktayı ÇAĞIRMADAN ÖNCE
    // index.ts'te vmware_mode==='vcenter' kontrolü yapılmalı.
    return this.get<VSphereCluster[]>("/api/vcenter/cluster");
  }
}
