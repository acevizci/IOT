-- RCA Confidence Motoru (madde 3): trafik-bazlı ilişkiler ClickHouse'da (NetFlow),
-- ama recursive CTE tabanlı kök-neden zincir analizi Postgres'te çalışıyor. Bu tablo,
-- flows-consumer'ın periyodik olarak (LLDP keşfindeki AYNI desen -- periyodik
-- materyalizasyon) ClickHouse'daki yoğun trafik ilişkilerini buraya UPSERT etmesiyle
-- doldurulur -- böylece adjacency graph'a (device_links + VMware hiyerarşisi ile
-- birlikte) TEK bir Postgres sorgusunda dahil edilebilir.
CREATE TABLE IF NOT EXISTS traffic_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  device_a_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  device_b_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  total_bytes BIGINT NOT NULL,
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_traffic_links_unique_pair
  ON traffic_links (tenant_id, LEAST(device_a_id, device_b_id), GREATEST(device_a_id, device_b_id));

CREATE INDEX IF NOT EXISTS idx_traffic_links_device_a ON traffic_links (device_a_id);
CREATE INDEX IF NOT EXISTS idx_traffic_links_device_b ON traffic_links (device_b_id);
