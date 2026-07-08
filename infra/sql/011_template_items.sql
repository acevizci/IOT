ALTER TABLE alert_templates ADD COLUMN IF NOT EXISTS parent_template_id UUID REFERENCES alert_templates(id);
ALTER TABLE alert_templates ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS template_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES alert_templates(id) ON DELETE CASCADE,
    metric_name TEXT NOT NULL,
    oid TEXT NOT NULL,
    data_type TEXT NOT NULL DEFAULT 'gauge',
    unit TEXT,
    polling_interval_seconds INT NOT NULL DEFAULT 60,
    is_table BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS template_graphs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES alert_templates(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    metric_names JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS device_templates (
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    template_id UUID NOT NULL REFERENCES alert_templates(id) ON DELETE CASCADE,
    PRIMARY KEY (device_id, template_id)
);
