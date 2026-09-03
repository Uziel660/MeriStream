# Transferencia completa de MeriStream

Rama: `codex/catalog-recovery-transfer-2026-09-03`

Esta rama congela el estado de trabajo del 3 de septiembre de 2026. Incluye
código frontend/backend, pruebas, migraciones Prisma, herramientas de
reimportación y recuperación, reportes, cursores de reanudación, snapshots y
el bundle generado en `dist/`.

Además, `database/snapshots/crawl-tasks-transfer-20260903.json` conserva las
33 tareas y sus colas `items_queue` completas en el punto de pausa. Es el
estado operativo que permite continuar el catálogo sin reconstruir objetivos.

## Preparar otra PC

```powershell
git clone --branch codex/catalog-recovery-transfer-2026-09-03 https://github.com/Uziel660/MeriStream.git
cd MeriStream
npm ci
npx prisma generate
```

Configura `DATABASE_URL`, `DIRECT_URL`, `TMDB_API_KEY`, `ADMIN_USER` y
`ADMIN_PASS` para esa máquina. La rama conserva el `.env` que ya existía en el
repositorio privado; si se va a compartir el repositorio con otra persona,
rota esas credenciales y reemplaza el archivo por valores locales.

## Base de datos

`meristream_prod.dump` es el dump PostgreSQL incluido para restauraciones
controladas. Antes de restaurar, crea una base vacía o un respaldo adicional y
confirma que `DATABASE_URL` apunta al destino correcto:

```powershell
pg_restore --clean --if-exists --no-owner --dbname="$env:DATABASE_URL" .\meristream_prod.dump
npx prisma migrate deploy
```

Los snapshots NDJSON comprimidos de `database/snapshots/` son respaldo de
consulta y auditoría; no se deben restaurar sobre una base activa sin probar el
procedimiento. Los cursores de `data/` y `docs/workstreams/` permiten reanudar
TMDB, catálogo y recuperación sin empezar desde cero.

El snapshot NDJSON más reciente disponible en la rama es el respaldo previo de
la recuperación masiva; el estado posterior de las colas está separado en el
JSON de `CrawlTask` anterior. Si la nueva PC apunta al mismo PostgreSQL, verá
inmediatamente todos los registros actuales. Para una base nueva, restaura el
dump/snapshot y deja que las tareas `pending` completen los registros creados
después del respaldo.

## Arranque

```powershell
npm run build
npm run start
```

Para desarrollo usa `npm run dev`. La pasada masiva se dejó detenida de forma
segura: las tareas que estaban `running` fueron devueltas a `pending` para que
el worker las continúe al iniciar la nueva PC. El avance detallado está en
`docs/workstreams/PROGRESO_EJECUCION_2026-09-03.md`.

## Verificación

```powershell
npm run lint
npx vitest run
```

La sonda HLS distingue un manifest real de una respuesta CDN vacía con HTTP
200, y el reproductor prioriza directos antes de embeds manteniendo los
localizadores canónicos para la resolución JIT.
