-- Zabbix-tarzı izleme proxy'si: uzak/segmentli bir sitedeki agent'lar merkez yerine
-- bu ara katmana bağlanır, proxy kendi yerel Postgres'inde buffer'layıp merkeze
-- batch olarak iletir. Kullanıcıyla konuşulup kararlaştırılan tasarım: 1 proxy = 1 site,
-- proxy kendi proxy_secret kimliğiyle merkeze bağlanır (agent PSK modeliyle aynı desen).

CREATE TABLE IF NOT EXISTS proxies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,                                    -- site adı (örn. "Ankara-DC2")
    address TEXT,                                          -- host:port (DNS ya da IP) -- agent'ların/merkezin ulaşacağı adres
    proxy_secret_hash TEXT,                                -- register olunca doldurulur (agent_psk deseniyle aynı sha256 hash)
    status TEXT NOT NULL DEFAULT 'pending',                -- pending (henüz register olmadı) | active | down
    heartbeat_seconds INTEGER NOT NULL DEFAULT 30,         -- proxy'nin kendi heartbeat aralığı -- Dashboard'dan ayarlanabilir
    metrics_flush_seconds INTEGER NOT NULL DEFAULT 30,     -- proxy -> core batch flush aralığı -- Dashboard'dan ayarlanabilir
    queue_retention_limit INTEGER NOT NULL DEFAULT 500,    -- agent'ın maxQueueFiles deseniyle tutarlı taşma sınırı
    last_heartbeat_at TIMESTAMPTZ,
    connected_device_count INTEGER NOT NULL DEFAULT 0,
    pending_queue_size INTEGER NOT NULL DEFAULT 0,
    last_successful_sync_at TIMESTAMPTZ,
    proxy_version TEXT,
    disk_usage_bytes BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_proxies_tenant ON proxies(tenant_id);

-- agent_registration_tokens (migration 062) ile birebir aynı desen -- tek kullanımlık,
-- iptal edilebilir kayıt token'ı. used_at, token'ın bir daha kullanılamamasını sağlar
-- (agent akışında bu revoked_at ile karışıyordu, proxy'de en baştan ayrı tutuluyor).
CREATE TABLE IF NOT EXISTS proxy_registration_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Proxy'den gelen batch'lerin idempotent işlenmesi: ağ hatası yüzünden proxy aynı
-- batch'i tekrar gönderirse (yanıt kaybolduğu için) mükerrer metrik kaydı önlenir.
-- Eski kayıtlar ayrı bir bakım görevi ile temizlenebilir (received_at indeksli).
CREATE TABLE IF NOT EXISTS proxy_metric_batches (
    batch_id UUID PRIMARY KEY,
    proxy_id UUID NOT NULL REFERENCES proxies(id),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_proxy_metric_batches_received ON proxy_metric_batches(received_at);

-- Cihaz hangi proxy üzerinden merkeze rapor veriyor -- NULL ise doğrudan core'a bağlanır.
-- Dashboard'daki host sayfasındaki proxy selectbox bunu günceller; redirect_server_url
-- mekanizması (core-service) bu alanla agent'ın şu an bağlandığı adresi karşılaştırır.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS assigned_proxy_id UUID REFERENCES proxies(id);

-- Proxy erişilemezlik alarmları -- YENİ bir alarm tablosu AÇILMIYOR, mevcut
-- alert_rules/alerts kullanılıyor ki Alarm Listesi widget'ı hiçbir değişiklik
-- gerektirmeden proxy alarmlarını da göstersin. device_id zaten nullable;
-- proxy_id de nullable ekleniyor, bir alarm satırında ikisinden sadece biri dolu olur.
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS proxy_id UUID REFERENCES proxies(id);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS proxy_id UUID REFERENCES proxies(id);

-- ÖNEMLİ: mevcut uq_alerts_open_rule_device_instance indeksine (ve onu hedefleyen 6
-- farklı ON CONFLICT ifadesine -- index.ts x4, anomalyDetection.ts, predictiveAnalytics.ts)
-- DOKUNULMUYOR -- Postgres'te ON CONFLICT hedefi, index'in predicate'iyle (WHERE koşuluyla)
-- BİREBİR aynı olmak zorunda, aksi halde "no unique or exclusion constraint matching"
-- hatası verir (bunu canlı testte yakaladık). Proxy alarmları için AYRI bir partial
-- unique index yeterli ve daha güvenli: device_id her zaman dolu olan mevcut satırlarda
-- zaten hiçbir NULL-tekillik belirsizliği yok (proxy satırları bu index'i hiç hedeflemiyor,
-- kendi ayrı ON CONFLICT hedeflerini kullanıyorlar).
CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_open_rule_proxy
  ON alerts (rule_id, proxy_id) WHERE resolved_at IS NULL AND proxy_id IS NOT NULL;

-- Bakım penceresi: proxy'ler de (maintenance_window_devices ile aynı desende) bakım
-- penceresine alınabilsin -- planlı kapanışta "proxy/site erişilemez" alarmı bastırılsın.
CREATE TABLE IF NOT EXISTS maintenance_window_proxies (
    maintenance_window_id UUID NOT NULL REFERENCES maintenance_windows(id) ON DELETE CASCADE,
    proxy_id UUID NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
    PRIMARY KEY (maintenance_window_id, proxy_id)
);

-- agent_releases'in çok basitleştirilmiş karşılığı -- proxy Docker image olarak
-- dağıtıldığı ve güncelleme otomatik/dosya-indirmeli DEĞİL (kullanıcıyla konuşulup
-- kararlaştırılan: manuel onaylı `docker compose pull`) olduğu için, burada sadece
-- "en güncel sürüm hangisi" bilgisi tutuluyor -- checksum/dosya yolu gerekmiyor.
CREATE TABLE IF NOT EXISTS proxy_releases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version TEXT NOT NULL UNIQUE,
    released_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
