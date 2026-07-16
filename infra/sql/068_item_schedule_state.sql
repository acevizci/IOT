-- Queue altyapisinin temeli: gercek, item-bazli zamanlama. Onceden 4 collector'in
-- (SNMP/SSH/SQL/Web) hepsi sabit bir dongude HER item'i topluyordu,
-- polling_interval_seconds hic okunmuyordu (kozmetik bir alandi). Bu tablo, her
-- (cihaz, kaynak) cifti icin "bir sonraki toplama ne zaman" bilgisini tutar --
-- collector'lar artik sadece vadesi gelen item'lari toplar. Reconcile/due/mark-
-- collected mantigi Core Service'in /api/v1/internal/schedule/* endpoint'lerinde
-- yasiyor (collector'lar bu tabloya DOGRUDAN erismez, sadece Core Service'in
-- sundugu API'yi kullanir -- mevcut reportCollectorStatus deseniyle tutarli).
CREATE TABLE IF NOT EXISTS item_schedule_state (
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('template_item', 'web_scenario')),
    resource_id UUID NOT NULL,
    collector_type TEXT NOT NULL,
    collected_by TEXT NOT NULL DEFAULT 'default', -- ileride proxy/instance ayrimi icin
    polling_interval_seconds INT NOT NULL,
    next_due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_collected_at TIMESTAMPTZ,
    last_duration_ms INT,
    last_error TEXT,
    PRIMARY KEY (device_id, resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_schedule_due ON item_schedule_state (collector_type, next_due_at);
