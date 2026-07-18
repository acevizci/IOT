#!/bin/bash
# FAZ J Adım 3 — Yük testi çalışırken/bittikten sonra durumu kontrol eder.
# Kullanım: ./scripts/check_loadtest.sh (repo kökünden çalıştırın)

set -e
COMPOSE="docker compose --env-file env/.env.dev -f infra/docker-compose.base.yml -f infra/docker-compose.dev.yml"

echo "=== Redis Stream (metrics.raw) durumu ==="
$COMPOSE exec -T redis redis-cli XLEN metrics.raw
$COMPOSE exec -T redis redis-cli XINFO GROUPS metrics.raw

echo ""
echo "=== metrics-consumer'ın son 10 satırı (yazma hızı gözlemi) ==="
$COMPOSE logs --tail=10 metrics-consumer

echo ""
echo "=== Postgres/TimescaleDB: loadtest verisi satır sayısı + gerçek boyut ==="
$COMPOSE exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT COUNT(*) as loadtest_satir_sayisi, pg_size_pretty(hypertable_size('"'"'metrics'"'"')) as toplam_hypertable_boyutu
FROM metrics WHERE metric_name LIKE '"'"'loadtest_%'"'"';
"'

echo ""
echo "=== Container kaynak kullanımı (CPU/RAM) ==="
docker stats --no-stream obs-postgres obs-redis obs-metrics-consumer obs-core obs-alarm-engine

echo ""
echo "=== Postgres: yazma gecikmesi/kilitlenme belirtisi var mı ==="
$COMPOSE exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT pid, state, wait_event_type, wait_event, query_start, now()-query_start as sure, LEFT(query,80) as sorgu
FROM pg_stat_activity WHERE state != '"'"'idle'"'"' AND datname = current_database() ORDER BY query_start;
"'
