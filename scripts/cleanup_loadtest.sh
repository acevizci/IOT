#!/bin/bash
# FAZ J Adım 3 — Yük testi bittikten sonra üretilen tüm test verisini temizler.
# Kullanım: ./scripts/cleanup_loadtest.sh (repo kökünden çalıştırın)

set -e
COMPOSE="docker compose --env-file env/.env.dev -f infra/docker-compose.base.yml -f infra/docker-compose.dev.yml"

echo "Silinecek satır sayısı:"
$COMPOSE exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT COUNT(*) FROM metrics WHERE metric_name LIKE '"'"'loadtest_%'"'"';"'

read -p "Devam edilsin mi? (evet/hayır) " confirm
if [ "$confirm" != "evet" ]; then
  echo "İptal edildi."
  exit 0
fi

$COMPOSE exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DELETE FROM metrics WHERE metric_name LIKE '"'"'loadtest_%'"'"';"'
echo "Temizlendi."
