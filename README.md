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
npm run dev
```

Scripts principales:

```bash
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
