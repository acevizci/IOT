-- SYSLOG TOPLAYICI (Pasif Log) -- SNMP Trap alıcısından (080) sonraki sıradaki
-- pasif collector. Trap gibi cihaz bize GÖNDERİR (aktif sorgulama değil), ama trap'ten
-- farklı olarak asıl değer serbest-metin MESAJIN kendisindedir. Bu yüzden trap'in
-- yaptığı gibi metrics tablosunun instance_label'ına sıkışmak yerine, mesaj metnini
-- KENDİ tablosunda (syslog_messages) saklıyoruz; ayrıca alarm motoru mevcut şablon/
-- kural altyapısıyla çalışabilsin diye severity'yi bir metrik (syslog_message) olarak
-- da yayınlıyoruz (bkz. syslogReceiver.ts).

-- 1) collector_types kaydı -- şablon sistemi bu metrikleri tanısın diye. Trap gibi
--    requires_device_config=false: pasif alıcı TEK bir UDP port'undan dinler, cihaz
--    başına ayrı bağlantı config'i gerekmez (kaynak IP ile eşleştirilir).
INSERT INTO collector_types (key, display_name, category, config_schema, handler_service, active, requires_device_config)
VALUES ('syslog', 'Syslog (Pasif Log)', 'network', '{"fields": []}', 'npm-service', true, false)
ON CONFLICT (key) DO NOTHING;

-- 2) syslog_messages -- ham log deposu. Metrik hattı (metrics-consumer) tags'ten
--    sadece instance_label/interface tutup gerisini attığı için, mesaj metnini o
--    hattan GEÇİRMİYORUZ; receiver bu tabloya DOĞRUDAN yazar. TimescaleDB hypertable
--    (metrics ile aynı desen) -- syslog hacimli olabilir, zaman-bazlı chunk'lama ve
--    retention şart.
CREATE TABLE IF NOT EXISTS syslog_messages (
    time          TIMESTAMPTZ NOT NULL,
    tenant_id     UUID NOT NULL,
    device_id     UUID NOT NULL,
    facility      SMALLINT,            -- RFC 5424 facility (0-23)
    severity      SMALLINT NOT NULL,   -- RFC 5424 severity (0=emerg ... 7=debug)
    severity_name TEXT NOT NULL,       -- okunur ad ('err', 'warning', ...)
    hostname      TEXT,                -- mesajdaki HOSTNAME alanı (kaynak IP'den ayrı)
    appname       TEXT,                -- RFC 5424 APP-NAME / RFC 3164 TAG
    message       TEXT NOT NULL        -- serbest-metin gövde
);

SELECT create_hypertable('syslog_messages', 'time', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);

-- Widget sorgusu: tenant başına zaman sırasıyla son N mesaj (+ opsiyonel grup/severity filtresi).
CREATE INDEX IF NOT EXISTS idx_syslog_lookup ON syslog_messages (tenant_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_syslog_device ON syslog_messages (tenant_id, device_id, time DESC);

-- Retention: ham syslog 30 gün saklanır (metrics ile tutarlı). Hacim yüksek olabileceği
-- için bu ÖNEMLİ -- aksi halde disk şişer. if_not_exists ile idempotent.
SELECT add_retention_policy('syslog_messages', INTERVAL '30 days', if_not_exists => TRUE);

-- 3) syslog_patterns -- kullanıcı-tanımlı regex desenleri. Bir mesaj bir desene
--    (regex) uyuyor VE severity'si min_severity eşiğinden düşük/eşitse (yani en az o
--    kadar ciddiyse), receiver 'metric_name' adıyla value=1 bir metrik yayınlar ve
--    instance_label = desen adı olur. Böylece kullanıcı, mevcut alarm/şablon
--    sistemiyle o metrik adı üzerinden kural tanımlar -- YENİ bir alarm altyapısı
--    gerekmez (tag-farkında alarm motoru, 075, zaten instance_label'a göre gruplar).
CREATE TABLE IF NOT EXISTS syslog_patterns (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL,
    name         TEXT NOT NULL,
    regex        TEXT NOT NULL,
    metric_name  TEXT NOT NULL,
    -- min_severity: desen SADECE severity <= bu değer olan (yani en az bu kadar ciddi)
    -- mesajlarda değerlendirilir. Varsayılan 7 (debug) = ciddiyet filtresi yok, tüm
    -- mesajlarda regex denenir.
    min_severity SMALLINT NOT NULL DEFAULT 7 CHECK (min_severity BETWEEN 0 AND 7),
    enabled      BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_syslog_patterns_tenant ON syslog_patterns (tenant_id) WHERE enabled;

-- 4) Trap Log widget'ında (081) yapılan AYNI hatayı tekrarlamamak için: dashboard_widgets
--    CHECK constraint'i ile Zod enum'u (services/core/src/index.ts -- CreateWidgetSchema
--    VE BulkWidgetSchema) AYNI TURDA güncellenir. Burada 'syslog_log' ekleniyor; kod
--    tarafındaki iki enum da bu commit'te güncellendi.
ALTER TABLE dashboard_widgets DROP CONSTRAINT IF EXISTS dashboard_widgets_widget_type_check;
ALTER TABLE dashboard_widgets ADD CONSTRAINT dashboard_widgets_widget_type_check
  CHECK (widget_type = ANY (ARRAY[
    'graph'::text, 'problem_list'::text, 'device_status'::text, 'kpi_card'::text,
    'severity_distribution'::text, 'problem_devices'::text, 'top_n'::text, 'platform_summary'::text,
    'service_health'::text, 'escalation_history'::text, 'maintenance_windows'::text,
    'device_card'::text, 'status_badge'::text, 'raw_table'::text, 'note'::text, 'clock'::text,
    'url'::text, 'gauge'::text, 'pie_chart'::text, 'device_explorer'::text, 'status_grid'::text,
    'web_monitoring_summary'::text, 'host_performance_table'::text,
    'vmware_cluster_summary'::text, 'vmware_datastore'::text, 'vmware_vm_table'::text,
    'trap_log'::text, 'syslog_log'::text
  ]));
