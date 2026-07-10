CREATE TABLE IF NOT EXISTS escalation_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_template_rule_id UUID NOT NULL REFERENCES alert_template_rules(id) ON DELETE CASCADE,
    step_order INT NOT NULL DEFAULT 1,
    delay_seconds INT NOT NULL DEFAULT 0,
    action_type TEXT NOT NULL CHECK (action_type IN ('notify', 'remote_command')),
    media_type_id UUID REFERENCES media_types(id),
    remote_command TEXT
);

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS last_escalation_step INT NOT NULL DEFAULT 0;
