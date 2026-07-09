-- device_links'in her iki yönde de (A-B ve B-A) aynı çift için tekrar oluşmasını engelle
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_links_unique_pair
  ON device_links (tenant_id, LEAST(device_a_id, device_b_id), GREATEST(device_a_id, device_b_id));
