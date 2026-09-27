# Docker deployment

This repository runs as two Compose services: `app` (the production frontend and Node API) and `db` (PostgreSQL 18.6). The app image is built in multiple stages from repository source, so the final image does not contain the compiler or test dependencies.

## First start

Clone the repository, create the environment file, and start the stack:

```bash
cp .env.example .env
# Edit .env and replace every CHANGE_ME value.
docker compose up --build -d
```

On Windows PowerShell, use `Copy-Item .env.example .env` in place of `cp`.

The sanitized public catalog seed must be present at `database/seed/meristream-catalog.pgcustom`. It is a PostgreSQL custom-format dump generated with PostgreSQL 18.6 (`pg_dump --format=custom`, also written as `pg_dump -Fc`). Its current SHA-256 is `053c4be7ee099809b0b7434aee551d19d9c3c0278a8450edbc422614936ecedd`. The seed is restored by `scripts/docker/postgres-init.sh` only while PostgreSQL creates a brand-new data directory. The historical `meristream_prod.dump` file was obsolete and is deliberately excluded from the build context.

The database healthcheck remains unhealthy until PostgreSQL accepts connections, the restore marker exists, and the restore-completion row is committed. The app waits for this healthcheck before it starts. A successful first start can take several minutes for a large catalog.

The named volume `meristream_pgdata` keeps data across container recreation. Do not run `docker compose down -v` unless you intend to delete that database volume.

## Configuration

The minimum values are the PostgreSQL credentials and the four application secrets (`ADMIN_USER`, `ADMIN_PASS`, `ADMIN_SESSION_SECRET`, and `JWT_SECRET`). Use long random values. Compose constructs the internal URL with the hostname `db`; a `DATABASE_URL` value used for local host development is not used by the container.

`POSTGRES_PASSWORD` is interpolated into that URL, so use a URL-safe password (letters, numbers, `_`, and `-`) or provide a separately encoded deployment configuration. `ALLOWED_ORIGINS` should contain the browser origins that will call the API. Set `ENFORCE_HTTPS=true` only when the deployment is behind an HTTPS reverse proxy or tunnel that sends `X-Forwarded-Proto`.

## Backups

Back up the live database in PostgreSQL custom format while the stack is running:

```bash
./scripts/docker/backup.sh backups/meristream-$(date -u +%Y%m%dT%H%M%SZ).dump
```

PowerShell:

```powershell
.\scripts\docker\backup.ps1
```

Keep backups outside the public repository. They contain application data and may include user records, password hashes, lists, progress, and watch history. Store them encrypted with restricted access.

## Restoring a backup

Restoration is an explicit destructive operation. Stop the app, preserve the existing volume, and create a separate empty volume or a separate Compose project before testing a restore. For a full replacement of the local database, the following removes the named volume after you have made a backup:

```bash
docker compose down
docker compose down -v
docker compose up --build -d
```

That command restores the repository seed, not an arbitrary backup. To test an operator backup, use an isolated PostgreSQL 18.6 container without the repository init mounts. The example below creates a disposable volume and restores only after the server accepts connections; verify the dump checksum and contents first:

```bash
docker volume create meristream_restore_pgdata
docker run --rm -d --name meristream-restore-db \
  -e POSTGRES_USER="$POSTGRES_USER" \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -e POSTGRES_DB="$POSTGRES_DB" \
  -e PGDATA=/var/lib/postgresql/18/docker \
  -v meristream_restore_pgdata:/var/lib/postgresql \
  postgres:18.6-alpine
until docker exec meristream-restore-db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"; do sleep 2; done
docker exec -i meristream-restore-db sh -c \
  'pg_restore --exit-on-error --no-owner --no-privileges --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  < backups/meristream-YYYYMMDDTHHMMSSZ.dump
docker stop meristream-restore-db
docker volume rm meristream_restore_pgdata
```

Never run `pg_restore --clean` against the production volume without a verified backup and a maintenance window. The automatic seed path intentionally never restores over a non-empty volume.

## Useful checks

```bash
docker compose ps
docker compose logs --tail=100 db
docker compose logs --tail=100 app
```

The application endpoint is available at `http://127.0.0.1:3010/health` by default. PostgreSQL is bound to `127.0.0.1:5433` by default and is not exposed on the public network.
