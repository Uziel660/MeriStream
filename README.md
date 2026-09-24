# MeriStream

MeriStream es una plataforma personal de catálogo y reproducción multimedia con frontend React, API Node.js, PostgreSQL y resolución Just-In-Time de fuentes reproducibles.

La identidad pública del contenido se basa principalmente en TMDB. Los proveedores externos aportan fuentes y disponibilidad; no son la identidad canónica del catálogo.

## Arquitectura

```text
TMDB / metadata
      ↓
catálogo público
      ↓
TMDB ID canónico
      ↓
Provider Gateway
      ↓
HLS / DASH / MP4
      ↓
resolución JIT + failover
      ↓
reproductor interno
```

Componentes principales:

- **Frontend:** React + Vite.
- **Servidor:** Node.js + Express + TypeScript.
- **Base de datos:** PostgreSQL + Prisma.
- **Playback:** Hls.js, dash.js y Plyr.
- **Resolución:** gateway de providers, resolutores de embeds/locators y sesiones proxy cuando una fuente no puede reproducirse directamente.
- **Usuarios:** autenticación, progreso de reproducción y listas.
- **Watch Party:** sincronización mediante WebSocket.
- **Workers:** ingestión, mantenimiento y verificación de fuentes.

## Catálogo y providers

El catálogo público usa TMDB como identidad principal y expone IDs estables por película, serie o anime.

La política operativa de providers vive en:

```text
server/providers/providerPolicy.ts
```

Los targets de ingestión completa viven en:

```text
server/providers/ingestionRegistry.ts
```

Actualmente el flujo normal de ingestión incluye entradas para:

- Cinecalidad
- Gnula
- LatAnime
- TioAnime
- Doramasflix
- Internet Archive

Otros providers pueden participar mediante resolución directa/JIT según su política. Los providers marcados como `legacy` se conservan para compatibilidad o recuperación explícita y no deben volver al ranking principal de forma automática.

El reproductor interno solo considera como fuentes directas formatos reproducibles como HLS, DASH o MP4. Páginas y embeds sin resolver quedan como candidatos de recuperación; no sustituyen una fuente de video válida.

## Inicio recomendado: Docker

Requisitos:

- Docker
- Docker Compose

Crea el archivo de entorno:

```bash
cp .env.example .env
```

En PowerShell:

```powershell
Copy-Item .env.example .env
```

Sustituye todos los valores `CHANGE_ME` y arranca:

```bash
docker compose up --build -d
```

Servicios:

- Aplicación: `http://127.0.0.1:3010`
- PostgreSQL local: `127.0.0.1:5433`
- Healthcheck: `http://127.0.0.1:3010/health`

El volumen `meristream_pgdata` conserva PostgreSQL entre recreaciones de contenedores.

No ejecutes `docker compose down -v` salvo que quieras eliminar la base de datos local.

## Variables de entorno

Las variables completas y sus valores por defecto seguros están en `.env.example`.

Las esenciales son:

| Variable | Uso |
| --- | --- |
| `POSTGRES_USER` | Usuario de PostgreSQL |
| `POSTGRES_PASSWORD` | Contraseña de PostgreSQL |
| `POSTGRES_DB` | Base de datos |
| `ADMIN_USER` | Usuario administrador |
| `ADMIN_PASS` | Contraseña del administrador |
| `ADMIN_SESSION_SECRET` | Firma de sesión administrativa |
| `JWT_SECRET` | Firma de autenticación |
| `TMDB_API_KEY` | Acceso al catálogo/enriquecimiento de TMDB |
| `ALLOWED_ORIGINS` | Orígenes autorizados para el navegador |
| `ENFORCE_HTTPS` | Fuerza HTTPS cuando existe proxy/túnel compatible |

Las integraciones de providers y subtítulos se configuran también desde `.env.example`.

## Desarrollo local

Instala dependencias:

```bash
npm install
```

Configura una instancia PostgreSQL y una `DATABASE_URL` válida, luego:

```bash
npx prisma generate
npx prisma db push
npm run dev
```

Comandos principales:

```bash
npm run dev
npm run build
npm start
npm run lint
npm test
npm run test:e2e
npm run db:generate
npm run db:push
npm run bootstrap
npm run ingest:all
```

`npm run bootstrap` prepara catálogo persistente cuando se necesita una base inicial. `npm run ingest:all` encola la ingestión de los targets activos definidos en el registro actual.

## API principal

Base:

```text
/api/v1
```

Rutas clave:

| Ruta | Uso |
| --- | --- |
| `GET /api/v1/catalog/public` | Catálogo público por TMDB |
| `GET /api/v1/catalog/public/:kind/:tmdbId` | Detalle canónico |
| `GET /api/v1/catalog/search` | Búsqueda |
| `GET /api/v1/providers/:kind/:tmdbId` | Resolución JIT de providers |
| `POST /api/v1/resolve-embed` | Resolución de locator/embed |
| `POST /api/v1/playback/sessions` | Sesión proxy renovable |
| `GET /api/v1/proxy/stream` | Entrega mediante proxy cuando es necesaria |

El frontend centraliza el acceso a la API en `src/api/client.ts`.

## Administración de PostgreSQL

Con Docker:

```bash
docker compose ps
docker compose logs --tail=100 db
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

Para Prisma Studio en desarrollo, configura `DATABASE_URL` hacia la instancia local y ejecuta:

```bash
npx prisma studio
```

No expongas PostgreSQL públicamente.

## Backups

Linux/macOS:

```bash
./scripts/docker/backup.sh backups/meristream-$(date -u +%Y%m%dT%H%M%SZ).dump
```

PowerShell:

```powershell
.\scripts\docker\backup.ps1
```

Los backups pueden contener cuentas, hashes, progreso e historial. Guárdalos fuera del repositorio y con acceso restringido.

La semilla de `database/seed/` solo se restaura automáticamente cuando PostgreSQL crea un volumen nuevo; no sobrescribe una base ya existente.

## Comprobaciones

```bash
docker compose ps
docker compose logs --tail=100 app
docker compose logs --tail=100 db
curl -fsS http://127.0.0.1:3010/health
```

Antes de cambios de esquema o restauraciones, crea un backup verificado.

## Seguridad y límites

- Nunca subas `.env`, cookies, tokens, bases privadas o backups.
- Rota cualquier secreto que haya sido publicado previamente.
- Mantén TLS/HTTPS en producción.
- MeriStream no debe desactivar TLS, evadir CAPTCHA/DRM ni saltarse controles de acceso de terceros.
- Una URL temporal firmada no debe tratarse como identidad persistente; conserva un locator estable y resuélvelo Just-In-Time.
