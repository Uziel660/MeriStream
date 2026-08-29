# MERISTREAM — Plataforma de Streaming Personal

**Versión 7.1** | Node.js + Express + TypeScript + React 18 + PostgreSQL 16

---

## Qué es esto

Una plataforma de streaming personal estilo Netflix que importa contenido desde 7+ sitios web, deduplica entre plataformas, enriquece metadatos automáticamente en español (TMDB, AniList, Jikan, TVMaze) y presenta todo con un reproductor HLS/MP4 integrado sin anuncios.

**Base de datos actual:** ~19,954 shows, ~116,274 episodios, ~295 fusiones cross-plataforma.

---

## Stack tecnológico

| Componente | Tecnología |
|------------|-----------|
| Backend | Node.js + Express 5 + TypeScript |
| Frontend | React 18 + TypeScript + Vite 6 |
| Base de datos | PostgreSQL 16 (Docker) |
| ORM | Prisma 5.22 |
| Estilos | Tailwind CSS 3 |
| Reproductor | Hls.js + Plyr |
| Scraping | Cheerio + adaptadores custom |
| Tests | Vitest 4 |
| Build | esbuild (backend) + Vite (frontend) |

---

## Requisitos

| Requisito | Versión mínima | Cómo verificar |
|-----------|---------------|----------------|
| Node.js | 18+ (recomendado 24) | `node --version` |
| npm | 8+ | `npm --version` |
| Docker | Cualquier versión reciente | `docker --version` |

---

## Instalación paso a paso

### 1. Clonar el repositorio

```bash
git clone https://github.com/Uziel660/finalnewtify.git
cd finalnewtify
```

### 2. Instalar dependencias

```bash
npm install
```

### 3. Arrancar PostgreSQL (base de datos)

```bash
docker run -d --name voidstream-pg ^
  -e POSTGRES_HOST_AUTH_METHOD=trust ^
  -e POSTGRES_DB=voidstream ^
  -e POSTGRES_USER=voidstream ^
  -e POSTGRES_PASSWORD=voidstream123 ^
  -p 5433:5432 postgres:16-alpine
```

> En Mac/Linux usá `\` en lugar de `^` para continuar la línea.

### 4. Crear archivo de configuración

Crear un archivo llamado `.env` en la raíz del proyecto:

```
DATABASE_URL="postgresql://voidstream:voidstream123@localhost:5433/voidstream?schema=public"
TMDB_API_KEY="tu-api-key-de-tmdb"
ADMIN_USER="admin"
ADMIN_PASS="tu-password"
ADMIN_SESSION_SECRET="genera-un-secreto-aleatorio-de-al-menos-32-bytes"
```

### 5. Preparar la base de datos

```bash
npx prisma db push
npx prisma generate
```

### 6. Arrancar la app

```bash
npm run dev
```

### 7. Abrir en el navegador

**http://localhost:3000** — página principal
**http://localhost:3000/admin** — panel de administración

---

## Scripts disponibles

```bash
npm run dev          # Arrancar en modo desarrollo
npm run build        # Compilar para producción (frontend + backend)
npm start            # Arrancar en modo producción
npm test             # Ejecutar tests (Vitest)
npm run lint         # Verificar tipos de TypeScript (tsc --noEmit)
npm run db:push      # Push schema a PostgreSQL
npm run db:generate  # Generar Prisma client
```

### Scripts de utilidad (tools/)

```bash
npx tsx tools/consolidate-seasons.cjs   # Consolidar temporadas por título (278 merges hechos)
npx tsx tools/auto-investigate.cjs      # Auto-investigar grupos inciertos vía TMDB API
npx tsx tools/prep-enrich.ts            # Repair posters + clear English descriptions
npx tsx tools/fast-migrate-pg.ts        # Migrar datos de SQLite a PostgreSQL
npx tsx tools/add-fulltext-search.ts    # Agregar índices de búsqueda full-text
npx tsx tools/merge-dbs.ts              # Fusionar múltiples bases SQLite
npx tsx tools/repopulate-source.ts      # Repoblar campo source desde dominios de episodios
```

---

## Variables de entorno (.env)

| Variable | Requerido | Descripción |
|----------|-----------|-------------|
| `DATABASE_URL` | Sí | Conexión a PostgreSQL |
| `TMDB_API_KEY` | Sí | API key de The Movie Database (metadatos en español) |
| `ADMIN_USER` | Sí para `/admin` | Usuario del panel administrativo |
| `ADMIN_PASS` | Sí para `/admin` | Contraseña del panel administrativo |
| `ADMIN_SESSION_SECRET` | Sí para `/admin` | Secreto aleatorio de al menos 32 bytes para firmar la sesión administrativa |
| `ALLOWED_ORIGINS` | No | Orígenes CORS permitidos (CSV). Si se omite, usa tunels detectados |

---

## Arquitectura general

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                        │
│  App.tsx → Home (Hero, GenreRows, CatalogFilters, Catalog)     │
│  AdminPanel → SmartImport, Batch, Workers, Verification, etc.  │
│  HLSPlayerModal → Selector de servidores, cascada, failover     │
└────────────────────────────┬────────────────────────────────────┘
                             │ fetch("/api/v1/...")
┌────────────────────────────▼────────────────────────────────────┐
│                     Backend (Express + TS)                       │
│  server.ts → Todas las rutas API REST                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐      │
│  │  Scrapers     │  │  Metadata    │  │  Workers         │      │
│  │  (12 adapters)│  │  (TMDB→AniL) │  │  (producer-      │      │
│  │  + Generic    │  │  →Jikan→TV   │  │   consumer)      │      │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘      │
│         │                  │                   │                 │
│  ┌──────▼──────────────────▼───────────────────▼─────────┐     │
│  │                  ShowService + WriteBuffer              │     │
│  │  Dedup → Merge → Enqueue → Sequential Writer → DB     │     │
│  └────────────────────────┬──────────────────────────────┘     │
│                           │                                     │
│  ┌────────────────────────▼──────────────────────────────┐     │
│  │                   PostgreSQL 16                        │     │
│  │  Show, Episode, MediaItem, MediaEpisode, SourceLink    │     │
│  │  + tsvector + GIN + pg_trgm (full-text search)        │     │
│  └───────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Plataformas de scraping (7 activas)

| Adaptador | Sitio | Tipo de contenido | Notas |
|-----------|-------|-------------------|-------|
| `LaMovieAdapter` | lamovie.org/.to/.ws | Películas, series, animes | TMDB season counts para episodios, pre-enriquecido |
| `TioAnimeAdapter` | tioanime.com | Anime | Paginación `?p=N`, catálogo completo |
| `AnimeFlvAdapter` | animeflv.net (+mirrors) | Anime | JavaScript inline, servidores múltiples |
| `LatAnimeAdapter` | latanime.org | Anime latino | Paginación `?p=N` |
| `VerAnimesAdapter` | veranimes.net | Anime | Paginación `?pag=N` |
| `CinecalidadAdapter` | cinecalidad.am/.mx/.im | Películas/series | Paginación `/page/N/` |
| `TioPlusAdapter` | tioplus.app | Películas/series | Patrón `/{path}/{N}` |

### Adaptadores adicionales

| Adaptador | Fuente | Uso |
|-----------|--------|-----|
| `TvMazeAdapter` | tvmaze.com | API de series internacionales |
| `ArchiveOrgAdapter` | archive.org | Películas de dominio público |
| `DirectStreamAdapter` | URLs directas | .m3u8, .mp4, .webm, .mkv |
| `GenericAdapter` | Cualquier sitio | Fallback universal |

### Cómo se registran

Los adaptadores se registran en `ScraperManager` por orden de prioridad. El primero que devuelva `canHandle(url) === true` gana. `GenericAdapter` siempre es el último recurso.

---

## Pipeline de metadatos

La función `enrichUniversalMetadata()` implementa una cascada:

```
TMDB es-MX (principal)
    ↓ si no hay match o es anime
AniList GraphQL → Kitsu API → Jikan MAL API
    ↓ si es serie/película
TVMaze API
    ↓ siempre
Internet Archive → Wikipedia es → Metadata por defecto
```

### Qué completa

- **Título**: canónico, japonés, inglés
- **Descripción**: TMDB es-MX, fallback AniList/Jikan, traducción Google Translate
- **Poster/backdrop**: rutas de TMDB
- **Géneros**: mapeados al español (50+ géneros)
- **Rating**: de la fuente o TMDB
- **Año y estado**: de la fuente o TMDB
- **tmdb_id**: para dedup y reconciliación

### Validación anti-falsos matches

`isSuspiciousAnimeMatch()` detecta matches TMDB sin género Animación o pre-1995 → AniList/Kitsu ganan si matchean mejor. Evita que "Dandelion" (anime) caiga en una TV movie británica de 1994.

---

## Deduplicación y consolidación

### Dedup en ingesta (`saveShowWithDeduplication`)

1. `parseRawTitle()` extrae título canónico + año + temporada + calidad
2. `normalizeTitleKey()` genera clave de fusión (slug, sin acentos, sin ruido)
3. Se busca show existente por `mal_id`, `normalized_title` o `base_normalized_title`
4. Si existe: se fusionan episodios (batch `createMany`), se mejoran gaps de metadatos
5. Si no existe: se crea show nuevo

### Consolidación de temporadas (`consolidate-seasons.cjs`)

- **278 merges** ejecutados
- Detecta marcadores: "S2", "2nd Season", "Temporada 3", "(ONA)", "(OVA)"
- Agrupa por título base normalizado + `tmdb_id`
- Guardas Jaccard (similitud de simtokens) para evitar falsos positivos
- Detección de spinoffs (no fusiona)
- Separación película vs serie

### Auto-investigación (`auto-investigate.cjs`)

- Investiga grupos inciertos vía TMDB API (colecciones, temporadas, IDs)
- **7 merges** adicionales
- Jaccard ≥ 0.15 para aceptar en grupos `tmdb_id`

### Reconciliación cross-plataforma (`reconcile-sequels`)

- Agrupa por `tmdb_id` → fusiona secuelas existentes
- **8 fusiones**, 101 episodios reubicados
- Detección automática de temporada desde título
- Dry-run por defecto (seguro)

### Fusión manual (`merge-works`)

```bash
POST /api/v1/catalog/merge-works
{ "keep_id": "...", "merge_id": "...", "dry_run": false }
```

Para pares que las guardas automáticas rechazan (idiomas distintos, etc.).

### Resultado total

| Métrica | Valor |
|---------|-------|
| Shows originales | ~21,133 |
| Shows después de consolidación | ~19,954 |
| Shows fusionados | 295 |
| Episodios reubicados | 5,023 |

---

## Verificación del Catálogo (Motor Unificado)

Motor de verificación unificado y multi-fuente (`server/verificationWorker.ts`) que mantiene la integridad del catálogo, enriquece metadatos y descubre nuevos episodios/fuentes de forma segura. Accesible desde la pestaña "Verificación" del panel Admin.

### Modos de Ejecución Manual

- **Solo metadatos** (`mode: "metadata"`): Revisa las obras dentro del alcance configurado y completa sinopsis, posters, banners, géneros y años faltantes consultando TMDB / AniList / TVMaze.
- **Verificación completa** (`mode: "full"`): Ejecuta la fase de metadatos y posteriormente el barrido de novedades por plataforma, deduplicando obras por `tmdb_id` + `kind`, vinculando episodios y conservando todas las fuentes (`SourceLink`) detectadas.

### Ajustes Automáticos

- `enabled` (boolean): Activa/desactiva la ejecución periódica en segundo plano.
- `interval_minutes` (number): Frecuencia de ejecución programada (mínimo **5 minutos**, default: 1440 min = 24h).
- `metadata_only` (boolean): Si está activo, las pasadas automáticas solo completan metadatos y omiten la fase de catálogo.
- `sync_known_episodes` (boolean): Si está activo, comprueba y agrega episodios nuevos en obras ya registradas.
- `scope_mode` (`"all"` | `"platforms"` | `"category"`): Define el universo de obras a verificar.

### Categorías Soportadas

- `anime`: Cubre adaptadores de anime (`animeflv`, `tioanime`, `latanime`, `lamovie_animes`).
- `movie` / `movies`: Cubre adaptadores de películas (`cinecalidad`, `tioplus`, `lamovie_movies`, `doramasflix_peliculas`).
- `series`: Cubre adaptadores de series (`lamovie_series`, `doramasflix`, `doramasflix_variedades`).

### Claves de Plataformas Válidas

- Predefinidas: `animeflv`, `tioanime`, `latanime`, `cinecalidad`, `tioplus`, `doramasflix`, `doramasflix_peliculas`, `doramasflix_variedades`, `lamovie_movies`, `lamovie_series`, `lamovie_animes`.
- Personalizadas: Se admiten claves adicionales siempre que tengan una URL válida asignada en `catalog_urls_by_platform`.

### Significado de las Métricas

- **Metadatos** (`updated_metadata`): Obras cuyos datos incompletos fueron completados en la fase de metadatos.
- **Obras nuevas** (`works_created`): Obras descubiertas e insertadas por primera vez en el catálogo.
- **Fusionadas** (`works_merged`): Obras identificadas como duplicados o secuelas con el mismo `tmdb_id` y consolidadas.
- **Episodios** (`episodes_added`): Nuevos episodios agregados a obras existentes o nuevas.
- **Fuentes aceptadas** (`sources_added`): Enlaces de streaming (`SourceLink`) aceptados por el write buffer durante la pasada; no confirma que ya se hayan persistido.
- **Errores** (`errors`): Total de fallos o excepciones capturadas durante la pasada.

### API de Verificación

```bash
# Consultar estado en vivo, progreso, último reporte y configuración
GET /api/v1/verification

# Actualizar configuración persistida (enabled, interval_minutes, scope_mode, etc.)
POST /api/v1/verification/config

# Disparar pasada manual (responde 202 si inició, 409 si ya está en curso)
POST /api/v1/verification/run { "mode": "full" }
```

---

## Write Buffer (cola de escrituras)

Los workers **nunca tocan la DB directamente**. Todo pasa por una cola en memoria:

```
Worker → enqueueWrite() → Cola RAM → Writer secuencial (5ms) → PostgreSQL
```

- **Capacidad**: ~200 escrituras/segundo
- **Overflow**: si la cola supera 500 entradas, se vacía a `data/write-buffer.jsonl`
- **Recuperación**: al boot, se recargan operaciones pendientes del JSONL
- **Retry**: máximo 5 intentos por operación. Duplicate key (P2002) se trata como éxito
- **Helper**: `GET /api/v1/write-buffer` expone estado (`ramPending`, `totalApplied`, `totalFailed`)

---

## Worker de rastreo

### Arquitectura productor-consumidor

```
Productor: discoverCatalogPages() → cola de items
    ↓ (page_concurrency=16 páginas en paralelo)
Consumidores: N workers (item_concurrency=24) → analyze + save
```

### Configuración

| Parámetro | Default | Descripción |
|-----------|---------|-------------|
| `max_concurrent_jobs` | 5 | Jobs de catálogo simultáneos |
| `page_concurrency` | 16 | Páginas de catálogo en paralelo |
| `item_concurrency` | 24 | Análisis de items en paralelo |
| `default_delay_ms` | 1500 | Delay entre requests |
| `jitter_enabled` | true | Jitter aleatorio |

### Ciclo de vida de un job

`pending` → `running` (claim atómico) → `completed` / `failed` / `paused` / `cancelled`

- **Pausa**: el job queda `"paused"` (no se re-arranca solo)
- **Borrado**: si está activo, se señaliza `"cancelled"` y se espera ≤3s
- **Reanudar**: pone `"pending"` explícito
- **Iniciar ahora**: `POST /api/v1/worker/jobs/:id/start` salta la cola

### Detección anti-bot

- Señales: `cf-mitigated`, `server: cloudflare`, "Just a moment", 429 repetidos
- **Auto-throttle por dominio**: ≥3 hits en 10 min → delay ×2 (máx ×4), expira a 10 min
- **Banner rojo** en UI (Ajustes del Worker) cuando hay bloqueos activos

### Patrones de paginación por sitio

| Sitio | Patrón |
|-------|--------|
| animeflv.net | `?page=N` |
| animeflv mirrors | `/anime/page/N/` |
| tioplus.app | `/{path}/{N}` |
| latanime.org | `?p=N` |
| tioanime.com | `?p=N` |
| veranimes.net | `?pag=N` |
| cinecalidad.am | `/page/N/` |
| lamovie | `?page=N` |

### Índice de re-escaneo rápido

`quickSyncKnownShow()`: para obras ya conocidas, compara lista de episodios contra la BD e inserta **solo los faltantes** (~2-4s vs 10-30s). Cableado en workers y verificación automática.

---

## Resolución de streams

### Cascada de resolución (`server/resolvers.ts`)

El resolver intenta extraer el stream real de un embed/iframe en este orden:

1. **Mega.nz** — Descifrado AES-128-CTR on-the-fly
2. **Vimeos.net** — POST download_orig → m3u8
3. **MP4Upload** — Unpack JS → .mp4
4. **YourUpload** — Extracción HTML
5. **OK.RU** — hlsManifestUrl del JSON
6. **VOE / ByseLapuix** — Regex + Base64 + redirect
7. **Byse SPA** — AES-256-GCM decrypt
8. **Streamtape** — Concatenación robotlink
9. **StreamWish / Filemoon / Vidmoly** — Packed embed (Dean Edwards)
10. **DoodStream** — pass_md5.sh
11. **Uqload** — Packed JS → MP4
12. **Vidhide / Vixhide** — Packed jwplayer → m3u8/mp4
13. **Fallback genérico** — Extracción de URLs del HTML

### Dead provider blacklist

`voe.sx`, `mixdrop`, `mxdrop`, `filemoon` — descartados del排序 por `streamSorter` y del frontend por `streamOptimizer`.

### Perfiles de CDN (`hostProfiles.ts`)

| CDN | Referer | Headers especiales |
|-----|---------|-------------------|
| vimeos.* | none | `Accept-Encoding: identity`, Chrome 124 UA |
| goodstream.one | none | `Sec-Fetch-Mode: cors` |
| zilla-networks.com | none | `Sec-Fetch-Site: same-origin` |
| dood.* | passthrough | — |
| mp4upload.com | fijo (`mp4upload.com`) | — |
| ducvomes.com / playmudos.com | passthrough | — |
| turboviplay.com | fijo (`tioplus.app/`) | — |

### Proxy anti-CORS (`/api/v1/proxy/stream`)

- Reescribe manifest M3U8 (URLs relativas → absolutas)
- Proxy de chunks MP4 con soporte Range/206
- Sigue redirects
- Stealth HTTP client (undici + profiles)
- MEGA: streaming nativo con descifrado on-the-fly

---

## Reproductor (HLSPlayerModal)

### Características

- **HLS.js** con calidad adaptable (Auto + selección manual)
- **Selector de servidores** siempre visible cuando hay >1 opción
- **Failover automático**: al error, intenta siguiente servidor en cascada
- **Búsqueda de mejor servidor**: HEAD probe + score por tier + prioridad backend
- **Audio y subtítulos**: selección de pistas
- **Velocidad**: 0.5x a 2x
- **Picture-in-Picture**
- **Fullscreen**
- **Atajos de teclado**
- **Telemetría**: detección de pantalla negra, buffering, errores → `/api/v1/network/player-event`

### Selector premium por plataforma

El backend adjunta `source_site` en todas las rutas de reproducción. El panel muestra primero el MEJOR servidor de cada plataforma (badge = plataforma, no servidor). Sin datos reales no se fuerza nada.

### Resolución multi-plataforma

Al reproducir un episodio, el backend intenta resolver streams de hasta 3 plataformas adicionales en paralelo (timeout 8s). Si la plataforma primaria no tiene streams, el frontend puede failover a streams de otras plataformas automáticamente.

### Auto-advance en fallo de embed

Cuando un servidor devuelve `resolved: false` o falla con error de red, el player avanza automáticamente al siguiente servidor sin intervención del usuario. Se muestra un toast informativo ("Conectando automáticamente a servidor de respaldo...").

---

## Interfaz de usuario

### Página principal (`App.tsx`)

| Sección | Contenido |
|---------|-----------|
| **AmbientGlow** | Resplandor dinámico según color dominante del contenido enfocado |
| **HeroBanner** | Show aleatorio (rating ≥7), Ken Burns effect, botones pill |
| **Continue Watching** | Tarjetas horizontales con barra de progreso (localStorage) |
| **Recomendaciones** | "Porque te gusta {topGenre}" basado en historial |
| **Recién Agregados** | Primeros 50 por fecha de ingesta |
| **Destacados por la Crítica** | Grid bento asimétrico (top 10 por rating) |
| **Filas de Género** | Top 5 géneros, cada uno con hasta 40 items por rating |
| **Catálogo Explorable** | Grid responsive 2-6 columnas con "cargar más" (100 a la vez) |

### Búsqueda

- **Local**: carga catálogo una vez (~2MB), filtra en memoria (`Array.filter()`)
- **Instantánea**: cero API calls, debounce 300ms
- **Server-side**: fallback tsvector + GIN cuando el catálogo crece

### Filtros (`CatalogFilters`)

| Filtro | Opciones |
|--------|----------|
| Año | "Todos los años" + años disponibles (1940→actual+1) |
| Orden | Recientes / Mejor rating / Más nuevas / A→Z |
| Limpiar | Botón X resetea ambos filtros |

### Etiquetas SIEMPRE en español

- "movie" → "Película"
- "series" → "Serie"
- "anime" → "Anime"

---

## Panel de administración (`/admin`)

### Login

Configura `ADMIN_USER`, `ADMIN_PASS` y `ADMIN_SESSION_SECRET` en `.env`. Si falta alguna, el servidor mantiene las rutas públicas operativas pero bloquea `/admin` y el plano administrativo con `503`.

La sesión administrativa es una cookie `HttpOnly`, `SameSite=Strict` (y `Secure` en producción), independiente de los tokens de usuarios normales. Cierra la sesión con el botón **X** del panel; esto invalida la cookie y vuelve al inicio.

### Pestañas

| Pestaña | Funcionalidad |
|---------|---------------|
| **Smart Import** | Analizar URL, importar show individual |
| **Batch Import** | Hasta 15 URLs simultáneas, importación en lote |
| **Background Tasks** | Crear/pausar/reanudar/cancelar jobs de rastreo, ajustes de worker en vivo |
| **Server Tester** | Probar todos los servidores de una plataforma, prioridades de servidor |
| **Verification** | Verificación automática programable (metadatos + novedades) |
| **Sources (Fuentes)** | Ratings de sitio (0-10), habilitar/deshabilitar plataformas, prioridades |
| **Library (Biblioteca)** | Navegar catálogo completo, editar shows, refresh de streams, borrar DB |

### Editor de obras (`ShowEditModal`)

- **Campos editables**: título, descripción, géneros, año, rating, estado, categoría, poster, banner, títulos alternativos
- **Refresh Streams**: re-resuelve servidores JIT para todos los episodios (background)
- **Plataformas**: muestra dónde está disponible el título (plataforma normalizada + cantidad de episodios). CDN subdominios (acek-cdn, dramiyos-cdn, turboviplay) se ocultan del display y se agrupan bajo la plataforma real.
- **Cascada multi-fuente**: servidores por plataforma ordenados por prioridad

### Reconciliación de catálogo

```bash
# Dry-run (seguro, solo muestra qué haría)
POST /api/v1/catalog/reconcile-sequels

# Ejecutar fusión
POST /api/v1/catalog/reconcile-sequels  { "dry_run": false }
```

### Fusión manual

```bash
POST /api/v1/catalog/merge-works
{ "keep_id": "show-a", "merge_id": "show-b", "dry_run": false }
```

---

## API REST — Todos los endpoints

### Shows

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/v1/shows` | Listar shows (?lite=true, ?search=, ?category=, ?page=, ?limit=) |
| GET | `/api/v1/shows/:show_id` | Show con episodios, platforms, media_item_id |
| PUT | `/api/v1/shows/:show_id` | Editar campos (recalcula claves si cambia título) |
| DELETE | `/api/v1/shows/:show_id` | Eliminar show |
| POST | `/api/v1/shows/:show_id/refresh-streams` | Re-resolver streams (202 background) |

### Catálogo

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/v1/catalog/analyze` | Analizar URL o término de búsqueda |
| POST | `/api/v1/catalog/import-show` | Guardar show con dedup |
| POST | `/api/v1/catalog/batch-import` | Importar hasta 15 URLs |
| POST | `/api/v1/catalog/crawl` | Crear job de rastreo profundo |
| POST | `/api/v1/catalog/episode-servers` | Resolución JIT de servidores de episodio |
| POST | `/api/v1/catalog/merge-works` | Fusión manual de dos shows |
| POST | `/api/v1/catalog/reconcile-sequels` | Reconciliación automática por tmdb_id |
| POST | `/api/v1/catalog/reset-sample` | Eliminar TODOS los registros |

### Reproducción

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/v1/play/:episode_id` | Resolver streams JIT para un episodio |
| GET | `/api/v1/play-multi/:media_item_id` | Cascada multi-fuente (todos los SourceLinks) |
| GET | `/api/v1/proxy/stream` | Proxy anti-CORS para HLS/MP4 |
| GET | `/api/v1/proxy/image` | Proxy de imágenes |
| GET | `/api/v1/stream/mega` | Streaming nativo MEGA (descifrado AES) |
| POST | `/api/v1/resolve-embed` | Resolución híbrida de embeds |
| POST | `/api/v1/extract` | Extractor universal de streams |

### Metadata

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/v1/metadata/backfill` | Enqueue backfill de metadatos |
| GET | `/api/v1/metadata/backfill` | Estado del backfill worker |
| GET | `/api/v1/genres` | Géneros (DB + Jikan, cache 5min) |

### Workers

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/v1/worker/jobs` | Listar jobs (cache 2s) |
| GET | `/api/v1/worker/settings` | Config + estado anti-bot |
| POST | `/api/v1/worker/settings` | Actualizar config |
| POST | `/api/v1/worker/jobs/:job_id/pause` | Pausar job |
| POST | `/api/v1/worker/jobs/:job_id/resume` | Reanudar job |
| POST | `/api/v1/worker/jobs/:job_id/cancel` | Cancelar job |
| POST | `/api/v1/worker/jobs/:job_id/start` | Iniciar ahora |
| DELETE | `/api/v1/worker/jobs/:job_id` | Eliminar job |
| POST | `/api/v1/worker/clear-finished` | Limpiar jobs terminados |
| GET | `/api/v1/tasks/:task_id` | Monitor de logs en vivo |

### Plataformas

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/v1/sites/ratings` | Ratings de sitio |
| POST | `/api/v1/sites/ratings` | Upsert rating |
| GET | `/api/v1/platforms/:platform/works` | Works de una plataforma |
| POST | `/api/v1/platforms/:platform/test-servers` | Probar servidores |
| GET | `/api/v1/platforms/:platform/server-priorities` | Prioridades |
| POST | `/api/v1/platforms/:platform/server-priorities` | Guardar prioridades |
| POST | `/api/v1/platforms/:platform/server-priorities/move` | Mover servidor ↑↓ |

### Verificación

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/v1/verification` | Estado en vivo, progreso, último reporte y configuración |
| POST | `/api/v1/verification/config` | Actualizar configuración persistida |
| POST | `/api/v1/verification/run` | Ejecutar pasada de verificación manual (`mode: "metadata" \| "full"`) |

### Watchdog

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/v1/watchdog` | Estado |
| GET/POST | `/api/v1/watchdog/config` | Config |
| POST | `/api/v1/watchdog/run` | Ejecutar ahora |
| GET | `/api/v1/watchdog/reports` | Reportes recientes |
| GET | `/api/v1/watchdog/alert` | Alertas críticas |

### Red / Telemetría

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/v1/network/stats` | Estadísticas agregadas |
| POST | `/api/v1/network/player-event` | Eventos de player |
| GET/DELETE | `/api/v1/network/logs` | Logs |

### Sistema

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health`, `/api/v1/health` | Health check |
| POST | `/api/v1/admin/login` | Login admin |
| GET | `/api/v1/write-buffer` | Estado del write buffer |
| GET | `/api/v1/scraper/presets` | Presets de scraper |
| POST | `/api/v1/scraper/presets/:id` | Guardar preset |
| POST | `/api/v1/scraper/presets/:id/reset` | Reset preset |
| GET | `/api/v1/media` | Legacy compatibility |

### Autenticación

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/auth/register` | Registro de usuario (username + password) |
| POST | `/api/auth/login` | Inicio de sesión (devuelve JWT, 30 días) |
| GET | `/api/auth/me` | Verificar sesión activa (requiere Bearer token) |
| PATCH | `/api/auth/avatar` | Cambiar avatar del usuario |

### Progreso de Visualización

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/progress` | Obtener progreso del usuario autenticado |
| POST | `/api/progress` | Guardar/actualizar progreso de un episodio |
| DELETE | `/api/progress/:episodeId` | Eliminar progreso de un episodio |
| DELETE | `/api/progress/show/:showId` | Eliminar progreso de todos los episodios de un show |

### Recomendaciones

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/recommendations` | Recomendaciones personalizadas (opcional auth) |

---

## Schema de base de datos

### Show (catálogo legacy)

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (cuid) | PK |
| `mal_id` | Int? | Unique, MyAnimeList ID |
| `anilist_id` | String? | AniList ID |
| `tmdb_id` | Int? | The Movie Database ID |
| `title` | String | Título display |
| `original_title` | String? | Título original |
| `japanese_title` | String? | Título en japonés |
| `english_title` | String? | Título en inglés |
| `normalized_title` | String | Clave de dedup (slug) |
| `base_normalized_title` | String? | Título sin marcador de temporada |
| `description` | String | Descripción |
| `poster_url` / `banner_url` | String? | URLs de imágenes |
| `poster_path` / `backdrop_path` | String? | Rutas relativas TMDB |
| `category` | String | "anime", "movie", "series" |
| `rating` | Float | Rating 0-10 |
| `year` | Int | Año de estreno |
| `status` | String | "Finalizado", "En emisión", etc. |
| `genres` | String | Separados por coma |
| `source` | String | Plataforma de origen (lamovie, tioanime, etc.) |

### Episode

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (cuid) | PK |
| `show_id` | String | FK → Show (cascade delete) |
| `title` | String | Título del episodio |
| `episode_number` | Float | Número (soporta 0.5, 1.5, etc.) |
| `source_url` | String | URL del episodio en la plataforma fuente |

### MediaItem (arquitectura multi-fuente)

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (cuid) | PK |
| `normalized_title` | String | Clave de dedup |
| `title` | String | Título |
| `tmdb_id` | Int? | TMDB ID |
| `kind` | String | "movie", "series" |
| `year` | Int? | Año |
| `@@unique` | — | `[normalized_title, kind, year]` |

### MediaEpisode

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (cuid) | PK |
| `media_item_id` | String | FK → MediaItem (cascade) |
| `season_number` | Int | Default 1 |
| `episode_number` | Float | Número de episodio |
| `@@unique` | — | `[media_item_id, season_number, episode_number]` |

### SourceLink

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | String (cuid) | PK |
| `media_episode_id` | String | FK → MediaEpisode (cascade) |
| `source_site` | String | Dominio de la plataforma |
| `url` | String | URL del stream |
| `link_type` | String | "direct", "embed", etc. |
| `host` | String? | Hostname del CDN |
| `priority_tier` | Int? | Tier de prioridad |
| `is_verified` | Boolean | Si fue verificado |
| `@@unique` | — | `[media_episode_id, source_site, url]` |

### SiteRating

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `site` | String | Unique, dominio |
| `rating` | Float | 0-10, default 5.0 |
| `enabled` | Boolean | Si está habilitada |

### CrawlTask / WorkerSettingsStore

Tablas de soporte para jobs de rastreo y configuración del worker.

---

## Técnicas de rendimiento

### Backend

| Técnica | Dónde | Qué hace |
|---------|-------|----------|
| Write-Buffer RAM | `server/writeBuffer.ts` | Cola en memoria, writer secuencial 5ms |
| Endpoint lite | `?lite=true` | Shows sin episodios (~2MB vs ~15MB) |
| Full-Text Search | PostgreSQL tsvector + GIN | Búsqueda por texto en milisegundos |
| Fuzzy matching | pg_trgm | Tolerancia a typos |
| Paginación server-side | `?page=1&limit=500` | Evita traer 20K+ registros |
| MVCC PostgreSQL | Workers paralelos | Hasta 5 workers sin locks |

### Frontend

| Técnica | Dónde | Qué hace |
|---------|-------|----------|
| Catálogo en memoria | App.tsx | Carga una vez, filtra localmente |
| Búsqueda local | filteredShows useMemo | Array.filter() = instantáneo |
| Debounce 300ms | UnifiedHeader | Evita filtrar en cada tecla |
| Episodios bajo demanda | MediaDetailsModal | Solo carga al abrir título |
| Lazy loading imágenes | SmartImage | Cargan cuando entran en viewport |

### Scraping

| Técnica | Dónde | Qué hace |
|---------|-------|----------|
| Adaptadores Strategy | adapters/ | Cada sitio tiene su adaptador |
| Rate limiting + jitter | taskWorker.ts | Delay + jitter aleatorio |
| Anti-bot detection | antiBot.ts | Cloudflare, 429s, auto-throttle |
| Deduplicación | showService.ts | Por mal_id o título normalizado |
| Write buffer | writeBuffer.ts | Buffer JSONL → DB |

---

## Decisiones de arquitectura (NO TOCAR sin entender)

### 1. Write-Buffer: los workers NUNCA tocan la DB

```
Worker → enqueueWrite() → Cola RAM → Writer secuencial → DB
```

Evita carreras de escritura. Si varios workers escriben a la vez, PostgreSQL puede deadlockear.

**Si modificás:** Nunca pongas `prisma.show.create()` directo en un worker. Usá `enqueueShowCreate()`, `enqueueShowUpdate()`, `enqueueWrite()`.

### 2. Endpoint lite SIN episodios

```
Frontend → /shows?lite=true → shows sin episodes → filtro local
Modal → /shows/:id → show CON episodes → solo cuando se abre
```

19,954 shows × ~6 episodios promedio = ~120K registros. Traerlos todos es lento e inútil.

### 3. Búsqueda local vs server-side

```
Frontend: Array.filter() en memoria (instantáneo)
Backend: tsvector + GIN (fallback si el catálogo crece a 100K+)
```

### 4. Schema Prisma: campos calculados NO van en el schema

`search_vector` se maneja con raw SQL + trigger, NO en `schema.prisma`. Prisma no soporta tsvector.

### 5. IDs generados por el worker

Los IDs se generan EN EL WORKER antes de encolar, no en el writer. El worker necesita el ID para referencias cruzadas.

---

## Solución de problemas

### La app no arranca

| Error | Causa | Solución |
|-------|-------|----------|
| `Cannot find module` | Faltan dependencias | `npm install` |
| `ECONNREFUSED localhost:5433` | PostgreSQL no está corriendo | `docker start voidstream-pg` |
| `P2021: Table does not exist` | Tablas no creadas | `npx prisma db push` |
| `EPERM: operation not permitted` | Proceso usando el engine | Cerrar otras terminales con `npm run dev` |
| `P1000: Authentication failed` | Password incorrecta | Verificar `.env` y `POSTGRES_HOST_AUTH_METHOD=trust` |

### El reproductor no carga video

1. Verificá que la fuente tenga streams activos
2. Probá con otro servidor (el failover automático debería funcionar)
3. Revisá la consola del navegador (F12) para errores
4. Verificá si el CDN está bloqueado (ver pestaña Ajustes del Worker)

### La búsqueda es lenta

No debería serlo. Si lo es:
1. Verificá que el catálogo se cargó con `?lite=true`
2. Abrí DevTools > Network y fijate cuánto pesa `/api/v1/shows`

### El crawler no avanza

1. Verificá que la URL fuente esté online
2. Revisá los logs en la pestaña "Jobs" del admin
3. Pausá y reanudá el trabajo
4. Revisá si hay bloqueos anti-bot (banner rojo en Ajustes)

---

## Portear a otras plataformas

### Android (Capacitor)

```bash
npm install @capacitor/core @capacitor/cli
npx cap init nitiflix com.nitiflix.app
npx cap add android
npm run build
npx cap sync
npx cap open android
```

- El backend corre en un servidor remoto
- Cambiar `localhost:3000` por la IP del servidor en `app.config.ts`
- El proxy anti-CORS DEBE correr en el servidor

### Deploy en servidor (producción) y Auto-Despliegue CI/CD

MeriStream cuenta con un pipeline de auto-despliegue continuo (CI/CD) de 0 MB de consumo en reposo mediante **GitHub Webhooks + Docker**. Consulta la guía detallada de arquitectura en:
👉 [`docs/DEPLOY_AUTONOMO_WEBHOOK.md`](docs/DEPLOY_AUTONOMO_WEBHOOK.md)

Para ejecución directa en servidor:

```bash
npm run build
npm start  # o node dist/server.cjs
```

- PM2 o systemd para mantener el proceso vivo
- PostgreSQL en RDS / Cloud SQL / DigitalOcean
- nginx como reverse proxy con SSL
- El dominio ngrok es solo para desarrollo

---

## Escalabilidad

| Métrica | Capacidad actual |
|---------|-----------------|
| Shows en catálogo | 20,000+ |
| Búsqueda local | Instantánea hasta 50K shows |
| Workers paralelos | 5 simultáneos |
| Escrituras/segundo | ~200 (write buffer) |
| Episodios | 116,000+ |

---

## Comandos útiles de PostgreSQL

```bash
# Verificar que está corriendo
docker ps | grep voidstream-pg

# Conectar a la base
docker exec -it voidstream-pg psql -U voidstream -d voidstream

# Ver shows
docker exec voidstream-pg psql -U voidstream -d voidstream -c "SELECT COUNT(*) FROM \"Show\";"

# Backup
docker exec voidstream-pg pg_dump -U voidstream voidstream > backup.sql

# Restaurar
cat backup.sql | docker exec -i voidstream-pg psql -U voidstream -d voidstream
```

---

## Licencia

Proyecto personal. Todos los derechos reservados.
