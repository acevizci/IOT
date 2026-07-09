ALTER TABLE collector_types ADD COLUMN IF NOT EXISTS requires_device_config BOOLEAN NOT NULL DEFAULT false;

UPDATE collector_types SET requires_device_config = true WHERE key IN ('ssh_exec', 'sql_postgres', 'sql_mysql');
