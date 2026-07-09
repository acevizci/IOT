CREATE TABLE IF NOT EXISTS web_scenarios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES alert_templates(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    user_agent TEXT,
    polling_interval_seconds INT NOT NULL DEFAULT 300
);

CREATE TABLE IF NOT EXISTS web_scenario_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario_id UUID NOT NULL REFERENCES web_scenarios(id) ON DELETE CASCADE,
    step_order INT NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    expected_status_code INT NOT NULL DEFAULT 200
);

INSERT INTO collector_types (key, display_name, category, config_schema, handler_service, requires_device_config) VALUES
  ('web_scenario', 'Web Senaryosu (çok adımlı HTTP kontrolü)', 'application', '{"fields":[]}', 'web-collector', false)
ON CONFLICT (key) DO NOTHING;
