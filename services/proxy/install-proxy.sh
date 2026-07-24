#!/bin/bash
# Monitoring Proxy kurulum script'i -- Dashboard'daki "Proxy Kurulumu" sayfasının
# ürettiği komutla çalıştırılır:
#   curl -fsSL <core-url>/install-proxy.sh | bash -s -- --token=... --core-url=... --name="..."
#
# Kullanıcıyla konuşulup kararlaştırılan tasarım: Docker yoksa otomatik kurar, proxy +
# kendi yerel Postgres'ini içeren bağımsız bir stack'i ayağa kaldırır.
#
# ÖNEMLİ: core-service'in Docker build context'i sadece services/core (bkz.
# services/core/Dockerfile) -- bu dosya buradan doğrudan servis edilemiyor, bu yüzden
# services/core/static/install-proxy.sh'a KOPYALANMIŞ bir hali var (GET /install-proxy.sh
# oradan okunur). Bu dosyada değişiklik yaparsan services/core/static/'teki kopyayı da
# güncellemeyi unutma.
set -euo pipefail

TOKEN=""
CORE_URL=""
NAME=""
ADDRESS=""
INSTALL_DIR="/opt/dco-proxy"

for arg in "$@"; do
  case $arg in
    --token=*) TOKEN="${arg#*=}" ;;
    --core-url=*) CORE_URL="${arg#*=}" ;;
    --name=*) NAME="${arg#*=}" ;;
    --address=*) ADDRESS="${arg#*=}" ;;
    --install-dir=*) INSTALL_DIR="${arg#*=}" ;;
    *) echo "Bilinmeyen argüman: $arg" >&2; exit 1 ;;
  esac
done

if [ -z "$TOKEN" ] || [ -z "$CORE_URL" ] || [ -z "$NAME" ]; then
  echo "Kullanım: install-proxy.sh --token=<TOKEN> --core-url=<URL> --name=<SITE_ADI> [--address=<host:port>] [--install-dir=<yol>]" >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Bu script root olarak çalıştırılmalı (Docker kurulumu ve /opt altına yazma için)." >&2
  exit 1
fi

# 1) Docker yoksa kur.
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Docker bulunamadı, kuruluyor (get.docker.com)..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "==> Docker Compose eklentisi bulunamadı, kuruluyor..."
  apt-get update -y >/dev/null 2>&1 && apt-get install -y docker-compose-plugin >/dev/null 2>&1 || true
  if ! docker compose version >/dev/null 2>&1; then
    echo "HATA: Docker Compose eklentisi kurulamadı, elle kurup tekrar dene." >&2
    exit 1
  fi
fi

# 2) Kurulum dizinini oluştur, docker-compose.yml'i core'dan indir.
echo "==> $INSTALL_DIR hazırlanıyor..."
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
curl -fsSL "$CORE_URL/install-proxy-compose.yml" -o docker-compose.yml

# 3) .env üret -- Postgres şifresi rastgele üretilir, bir daha elle girilmesi gerekmez.
if command -v openssl >/dev/null 2>&1; then
  POSTGRES_PASSWORD=$(openssl rand -hex 24)
else
  POSTGRES_PASSWORD=$(head -c 48 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
fi

cat > .env <<EOF
CORE_URL=$CORE_URL
REGISTRATION_TOKEN=$TOKEN
PROXY_NAME=$NAME
PROXY_ADDRESS=$ADDRESS
PROXY_HOST_PORT=8090
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
EOF
chmod 600 .env

# 4) Stack'i ayağa kaldır.
echo "==> Proxy stack'i başlatılıyor..."
docker compose pull
docker compose up -d

echo ""
echo "==> Kurulum tamamlandı. Durumu kontrol etmek için:"
echo "    cd $INSTALL_DIR && docker compose logs -f proxy"
echo "    Dashboard'daki Proxy'ler sayfasında birkaç saniye içinde 'Aktif' olarak görünmeli."
