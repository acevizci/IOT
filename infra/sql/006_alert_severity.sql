ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'warning'
  CHECK (severity IN ('info', 'warning', 'average', 'high', 'disaster'));

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_severity_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_severity_check
  CHECK (severity IN ('info', 'warning', 'average', 'high', 'disaster', 'critical'));
