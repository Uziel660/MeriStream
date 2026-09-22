#!/usr/bin/env bash
set -Eeuo pipefail

output_path="${1:-backups/meristream-$(date -u +%Y%m%dT%H%M%SZ).dump}"
mkdir -p "$(dirname "${output_path}")"

docker compose exec -T db sh -c \
  'pg_dump --format=custom --no-owner --no-privileges --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  > "${output_path}"

echo "Backup written to ${output_path}"
