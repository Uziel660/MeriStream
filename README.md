# MeriStream

Plataforma personal tipo Netflix con catálogo unificado, múltiples fuentes por obra/episodio y reproductor interno HLS/MP4.

## Documentación

**Fuente técnica principal:** [`docs/MERISTREAM.md`](docs/MERISTREAM.md)

Ahí están centralizados:

- arquitectura actual;
- TMDB/AniList/MAL e identidad;
- providers y prioridades ES/EN/JA;
- crawlers/workers;
- resolución JIT y playback;
- contratos y endpoints API;
- qué es legacy y qué se conserva;
- reglas para integrar APIs/providers nuevos.

## Stack

- Node.js + Express + TypeScript
- React + Vite
- PostgreSQL + Prisma
- Cheerio para scraping HTTP
- Hls.js/Plyr para reproducción
- Vitest para tests

## Inicio rápido desde BD vacía

```bash
npm install
```

Crea `.env` local:

```env
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/meristream?schema=public"
TMDB_API_KEY="tu_tmdb_key"
ADMIN_USER="admin"
ADMIN_PASS="cambia-esto"
ADMIN_SESSION_SECRET="secreto-largo-y-aleatorio"
```

Luego:

```bash
npx prisma generate
npx prisma db push
npm run bootstrap
npm run ingest:all
npm run dev
```

### 1. Bootstrap del catálogo

`npm run bootstrap` está pensado para una BD vacía. Por defecto crea un catálogo inicial canónico con TMDB:

- 250 películas;
- 100 series;
- 100 anime;
- temporadas/episodios de TV/anime;
- `SiteRating` inicial desde la policy de providers.

No inventa `SourceLink`: las fuentes de video solo se guardan cuando los providers/workers realmente las descubren.

Puedes cambiar el tamaño:

```bash
npm run bootstrap -- --movies=500 --series=300 --anime=300
```

Opciones útiles:

```text
--dry-run          valida sin escribir catálogo
--skip-episodes    crea MediaItem sin esqueletos de episodios
--delay-ms=150     ajusta pausa entre requests TMDB
--reset            vacía SOLO MediaItem/MediaEpisode si no existen SourceLink
```

El bootstrap es idempotente por `tmdb_id + kind`: puedes volver a ejecutarlo para ampliar/actualizar el catálogo sin duplicar obras.

### 2. Ingestión completa de providers

`npm run ingest:all` crea tareas `full_catalog` para todos los catálogos registrados en `server/providers/ingestionRegistry.ts` y el worker las procesa cuando arranca el servidor.

Incluye actualmente AnimeAV1, AnimeFLV, JKAnime, HiAnimes, GNULA, Cinecalidad, LaMovie, TubePelis, TioPlus, Doramasflix, LatAnime, TioAnime y VerAnimes.

Modo normal:

```bash
npm run ingest:all
npm run dev
```

Modo agresivo:

```bash
npm run ingest:all -- --fast
npm run dev
```

Volver a recorrer todos los catálogos desde cero sin duplicar jobs:

```bash
npm run ingest:all -- --refresh
npm run dev
```

Combinar refresh + máximo ritmo:

```bash
npm run ingest:all -- --refresh --fast
npm run dev
```

Solo ver qué tareas crearía:

```bash
npm run ingest:all -- --dry
```

`npm run fast-start` se conserva como alias de `npm run ingest:all -- --fast`.

El modo `full_catalog` no usa un número fijo de páginas: avanza hasta que el sitio deja de devolver contenido, con reanudación persistente y un fusible anti-loop.

Scripts principales:

```bash
npm run bootstrap
npm run ingest:all
npm run fast-start
npm run dev
npm run build
npm test
npm run lint
```

## Dirección técnica

```text
TMDB / AniList / MAL
        ↓
MediaItem → MediaEpisode → SourceLink[]
                          ↑
                crawlers/providers
                          ↓
                resolución Just-In-Time
                          ↓
                  reproductor interno
```

Los sitios externos son **providers de fuentes**, no la identidad del catálogo.

Prioridad de idiomas:

- Anime: **JA + SUB ES** > audio ES > JA + SUB EN.
- Películas/series: **EN y ES casi al mismo nivel**, con subtítulos ES/EN como bonus.

## Seguridad

No versionar nunca:

```text
.env
dist/
cookies.txt
secrets/tokens
```

Si un secreto ya estuvo en Git, hay que **rotarlo**; borrarlo del último commit no lo elimina del historial.
