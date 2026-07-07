CREATE TABLE IF NOT EXISTS flows (
    timestamp     DateTime,
    tenant_id     UUID,
    device_id     UUID,
    src_ip        IPv4,
    dst_ip        IPv4,
    src_port      UInt16,
    dst_port      UInt16,
    protocol      UInt8,
    bytes         UInt64,
    packets       UInt64,
    sampling_rate UInt32 DEFAULT 1
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (tenant_id, device_id, timestamp)
TTL timestamp + INTERVAL 90 DAY;
