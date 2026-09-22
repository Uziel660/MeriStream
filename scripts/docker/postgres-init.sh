#!/usr/bin/env bash
set -Eeuo pipefail

seed_path="/seed/meristream-catalog.pgcustom"
data_path="${PGDATA:-/var/lib/postgresql/data}"

if [[ ! -f "${seed_path}" ]]; then
  echo "[meristream] Missing sanitized seed: ${seed_path}" >&2
  echo "[meristream] Generate it with pg_dump --format=custom using PostgreSQL 18.6." >&2
  exit 1
fi

echo "[meristream] Restoring sanitized catalog seed from ${seed_path}..."
pg_restore \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  --username="${POSTGRES_USER}" \
  --dbname="${POSTGRES_DB}" \
  "${seed_path}"

# This marker is written only after pg_restore succeeds. It lets the database
# healthcheck distinguish a ready cluster from an interrupted restore, while
# leaving existing volumes untouched on later starts.
psql --dbname="${POSTGRES_DB}" --username="${POSTGRES_USER}" <<'SQL'
CREATE TABLE IF NOT EXISTS public._merilast_restore_status (
  id text PRIMARY KEY,
  restored_at timestamptz NOT NULL,
  seed_format text NOT NULL
);
INSERT INTO public._merilast_restore_status (id, restored_at, seed_format)
VALUES ('catalog-seed', clock_timestamp(), 'pg_dump-custom-18')
ON CONFLICT (id) DO UPDATE
SET restored_at = EXCLUDED.restored_at,
    seed_format = EXCLUDED.seed_format;
SQL

touch "${data_path}/.merilast-seed-restored"
echo "[meristream] Sanitized catalog seed restored successfully."
