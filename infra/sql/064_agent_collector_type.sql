-- Faz E'nin agent collector'ı için collector_types kaydı — bu, Faz E Aşama 1'de
-- unutulmuştu, template_items.collector_type foreign key ihlaline yol açıyordu
-- (44 template'in agent item'larını import ederken bulundu).
INSERT INTO collector_types (key, display_name, category, config_schema, handler_service, requires_device_config, active)
VALUES ('agent', 'Agent (Push)', 'os', '{}'::jsonb, 'agent-gateway', false, true)
ON CONFLICT (key) DO NOTHING;
