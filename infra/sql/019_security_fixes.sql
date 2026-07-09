-- Idempotency: aynı cihaz + aynı template kuralı için birden fazla satır oluşmasını engelle
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_rules_device_template_rule
  ON alert_rules (device_id, template_rule_id) WHERE template_rule_id IS NOT NULL;
