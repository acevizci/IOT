-- APM (Application Performance Monitoring): OpenTelemetry Protocol (OTLP) ile
-- gelen trace/span verisini saklar. flows tablosuyla AYNI mimari mantık --
-- yüksek hacimli zaman-serisi veri ClickHouse'da, Postgres'teki cihaz/servis
-- kayıtlarıyla (devices, device_type='service') service_name üzerinden eşleşir.
CREATE TABLE IF NOT EXISTS traces (
    timestamp        DateTime64(3),
    tenant_id        UUID,
    trace_id         String,
    span_id          String,
    parent_span_id   String,
    service_name     String,
    operation_name   String,
    duration_ms      Float64,
    status_code      UInt8,  -- OTel SpanStatus: 0=unset, 1=ok, 2=error
    kind             UInt8,  -- OTel SpanKind: 0=unspecified,1=internal,2=server,3=client,4=producer,5=consumer
    attributes       Map(String, String)
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (tenant_id, service_name, timestamp)
TTL timestamp + INTERVAL 30 DAY;
