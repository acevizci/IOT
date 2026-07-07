CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS metrics (
    time        TIMESTAMPTZ NOT NULL,
    tenant_id   UUID NOT NULL,
    device_id   UUID NOT NULL,
    metric_name TEXT NOT NULL,
    interface   TEXT,
    value       DOUBLE PRECISION NOT NULL,
    unit        TEXT
);

SELECT create_hypertable('metrics', 'time', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_metrics_lookup ON metrics (tenant_id, device_id, metric_name, time DESC);
