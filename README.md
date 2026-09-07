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

## Inicio rápido

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
npm run dev
```

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

Scripts principales:

```bash
npm run bootstrap
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
