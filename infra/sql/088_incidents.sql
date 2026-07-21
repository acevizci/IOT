-- RCA Adım 4: incidents + incident_affected_alerts.
-- Bir alarm açıldığında alarm-engine core'un /internal/root-cause-check endpoint'ini
-- çağırır; confidence>60 bir kök-neden adayı varsa bu tablolara yazılır. Incident,
-- kök-neden alarmı VE tüm etkilenen alarmlar çözülünce alarm-engine'in periyodik
-- reconcileIncidents() döngüsüyle otomatik kapanır.
CREATE TABLE IF NOT EXISTS incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  root_cause_device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  root_cause_alert_id UUID REFERENCES alerts(id) ON DELETE SET NULL,
  confidence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents (tenant_id, created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_incidents_root_cause_device ON incidents (root_cause_device_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS incident_affected_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  confidence INTEGER NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (incident_id, alert_id)
);
CREATE INDEX IF NOT EXISTS idx_incident_affected_alerts_incident ON incident_affected_alerts (incident_id);
