package main

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Proxy'nin kendi yerel şeması -- kullanıcıyla konuşulup kararlaştırılan tasarım:
// Postgres (SQLite değil, mevcut altyapıyla tutarlı), proxy'ye özel Docker container'ında.
const schemaSQL = `
CREATE TABLE IF NOT EXISTS proxy_state (
    id INTEGER PRIMARY KEY DEFAULT 1,
    proxy_id TEXT NOT NULL,
    proxy_secret TEXT NOT NULL,
    CONSTRAINT single_row CHECK (id = 1)
);

-- Bu proxy üzerinden rapor veren cihazların yerel önbelleği -- merkez ulaşılamazken
-- heartbeat'i yerelde "gördük" olarak işaretleyebilmek ve connected_device_count'u
-- hesaplayabilmek için (kullanıcıyla konuşulup kararlaştırılan self-metrik).
CREATE TABLE IF NOT EXISTS device_cache (
    device_id TEXT PRIMARY KEY,
    psk TEXT NOT NULL,
    agent_version TEXT,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Merkezden çekilen item listesinin önbelleği -- merkez ulaşılamazken agent'ın
-- item-sync döngüsü (RefreshActiveChecks) boş dönmesin diye.
CREATE TABLE IF NOT EXISTS item_cache (
    device_id TEXT PRIMARY KEY,
    items_json TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Merkezin "bu cihazlar sana atanmış" listesi (config-pull ile çekilir) -- burada
-- OLMAYAN ama device_cache'te bilinen bir cihaz görülürse, bir sonraki istekte
-- core'a yönlendirilir (core kendi resolveTargetServerUrl'ünü uygular).
CREATE TABLE IF NOT EXISTS assigned_devices (
    device_id TEXT PRIMARY KEY
);

-- Merkeze henüz iletilememiş (ya da iletilmeyi bekleyen) metrik kuyruğu -- agent'ın
-- disk-tabanlı queue.go'sunun DB'li/çok-cihazlı karşılığı. ORİJİNAL toplama zaman
-- damgası (timestamp) korunur -- kritik düzeltme: merkez artık bunu kabul ediyor,
-- flush anındaki "şimdi" ile ezmiyor (bkz. core-service clampMetricTimestamp).
CREATE TABLE IF NOT EXISTS metric_queue (
    id BIGSERIAL PRIMARY KEY,
    device_id TEXT NOT NULL,
    psk TEXT NOT NULL,
    agent_version TEXT,
    metric_name TEXT NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    unit TEXT,
    interface TEXT,
    tags_json TEXT,
    metric_timestamp TIMESTAMPTZ NOT NULL,
    queued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_metric_queue_queued_at ON metric_queue(queued_at);
`

func connectDB(databaseURL string) (*pgxpool.Pool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

func runMigrations(pool *pgxpool.Pool) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := pool.Exec(ctx, schemaSQL)
	return err
}
