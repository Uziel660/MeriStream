# 🎬 NITIFLIX / VOIDSTREAM — FULL-STACK MEDIA & STREAMING PLATFORM

> **Versión del Sistema:** 5.0.0 (Arquitectura de Escrituras Serializadas + Write-Buffer Outbox + Watchdog Auto-Reparador + Túnel ngrok + Configuración Ultra-Seria SQLite)
> **Estado:** 100% Funcional de Extremo a Extremo (Base de datos SQLite persistente con Prisma ORM, Arquitectura de Scrapers desacoplada con Adaptadores dedicados y Fallback Semántico, Resolutores de Video Embed multiserver, Validador de Streams, Enriquecimiento Multifuente con AniList/Kitsu/MAL/TMDB es-MX, Catálogo Interactivo con Estado Reactivo de Importación, Reproductor Híbrido HLS/Embed + Plyr con Proxy Anti-CORS, Worker de Tareas Persistente con Ejecución Paralela, Selector Premium por Plataforma, Deduplicación por Clave Canónica con Fusión de Secuelas, Backfill de Metadatos con Write-Buffer, Watchdog Auto-Reparador, Túnel ngrok para Acceso Externo).
> **Stack:** Node.js (Express + TypeScript + Cheerio + Prisma ORM + SQLite) + React 18 (TypeScript + Vite) + Tailwind CSS + Lucide Icons + Hls.js + Plyr + Vitest.

---

## 📋 Índice de Contenidos

1. [Visión y Filosofía](#1-visión-y-filosofía-del-proyecto)
2. [Arquitectura General del Sistema](#2-arquitectura-general-del-sistema)
3. [Arquitectura Híbrida de Scrapers (Strategy Pattern)](#3-arquitectura-híbrida-de-scrapers-strategy-pattern)
4. [Sistema Inteligente Anti-Duplicados](#4-sistema-inteligente-anti-duplicados)
5. [Estructura del Repositorio](#5-estructura-del-repositorio)
6. [Módulos del Backend (`server/`)](#6-módulos-del-backend-server)
7. [API REST Endpoints](#7-api-rest-endpoints)
8. [Guía de Instalación y Ejecución](#8-guía-de-instalación-y-ejecución)
9. [Suites de Pruebas Automatizadas](#9-suites-de-pruebas-automatizadas)
10. [Subsistemas v4.2 — Workers, Verificación, Reconciliación y Más](#10-subsistemas-v42--workers-verificación-reconciliación-y-más)
11. [Novedades v5.0 — Serialización SQLite, Write-Buffer, Watchdog y ngrok](#11-novedades-v50--serialización-sqlite-write-buffer-watchdog-y-ngrok)

---

## 1. Visión y Filosofía del Proyecto

Nitiflix es una plataforma de streaming personal, catálogo multimedia interactivo y motor de ingesta universal con estética cinematográfica de alta gama estilo Netflix / Stremio.

### Principios Fundamentales

1. **Persistencia y Cero Configuración Inicial:**
   La aplicación utiliza SQLite a través de Prisma ORM (`dev.db`), lo que permite que funcione instantáneamente sin requerir configurar servidores de bases de datos externos. Toda la estructura relacional de series, episodios, tareas del rastreador y configuraciones se mantiene persistente de forma nativa.

2. **Arquitectura Híbrida de Scrapers:**
   En lugar de un único scraper monolítico con condicionales frágiles, el sistema cuenta con adaptadores aislados para dominios específicos (*AnimeFLV, TVMaze, Archive.org, Direct Video*) y un adaptador genérico de respaldo que utiliza inteligencia semántica, metadatos OpenGraph y esquemas JSON-LD.

3. **Deduplicación Estricta Multi-API:**
   Al importar animes o series desde diferentes fuentes, el sistema verifica la obra contra **AniList GraphQL** y **Jikan / MyAnimeList (MAL)** antes de guardar. Identifica si el título o su `mal_id` ya existen en la base de datos y **fusiona los episodios** en la misma ficha en lugar de crear registros duplicados.

4. **Extracción Just-In-Time (JIT) de Fuentes de Video:**
   En el momento en que el usuario reproduce un episodio o película, el motor analiza la fuente en tiempo real, decodifica streams ocultos, resuelve servidores de video (*Streamwish, Filemoon, Mega, Voe, MP4Upload, StreamTape, YourUpload, Vidmoly, etc.*) y genera una lista ordenada por calidad y estabilidad.

---

## 2. Arquitectura General del Sistema

```
                                [ ENTRADA DE USUARIO ]
               (Búsqueda, Navegación de Catálogo o URL en Smart Ingest)
                                         │
                                         ▼
                         [ POST /api/v1/catalog/import-show ]
                                         │
                                         ▼
                       ┌────────────────────────────────────┐
                       │    saveShowWithDeduplication()     │
                       │       (server/showService.ts)      │
                       └─────────────────┬──────────────────┘
                                         │
                                         ▼ (Consulta APIs Oficiales)
                       ┌────────────────────────────────────┐
                       │   enrichUniversalMetadata()        │
                       │ (AniList 4K / Jikan MAL / Kitsu)   │
                       └─────────────────┬──────────────────┘
                                         │
                                         ▼ (Extracción de MAL ID + Títulos Canónicos)
                       ┌────────────────────────────────────┐
                       │     Verificación Anti-Duplicados   │
                       │  1. Match por mal_id               │
                       │  2. Match por normalized_title     │
                       └─────────┬────────────────┬─────────┘
                                 │                │
                        ┌────────┘                └────────┐
                        ▼                                  ▼
              [ YA EXISTE EN DB ]                  [ ES OTRA OBRA NUEVA ]
             (Fusiona nuevos episodios)            (Inserta Show + Episodes)
                        │                                  │
                        └────────────────┬─────────────────┘
                                         │
                                         ▼
                          ┌──────────────────────────────┐
                          │     BASE DE DATOS SQLITE     │
                          │    (Prisma ORM - dev.db)     │
                          │ - Show                       │
                          │ - Episode                    │
                          │ - CrawlTask                  │
                          │ - WorkerSettingsStore        │
                          └──────────────┬───────────────┘
                                         │
                                         ▼
                        [ FRONTEND REACT (Catálogo / Home) ]
                        - UnifiedHeader (Búsqueda + Filtros)
                        - HeroBanner con AmbientGlow dinámico
                        - BentoCollection & MediaRow interactivos
                        - Continuar viendo con progreso persistido
                        - AdminPanel (Smart Ingest + Monitor Worker)
                                         │
                                         ▼ (Usuario: "Play Episodio X")
                          [ GET /api/v1/play/:episode_id ]
                                         │
                                         ▼
                       ┌────────────────────────────────────┐
                       │    Extractor Just-In-Time (JIT)    │
                       │ - ScraperManager (Adaptadores)     │
                       │ - EmbedResolvers (Voe/Zilla/Mega)  │
                       │ - MediaValidator (HEAD/Range Check)│
                       └─────────────────┬──────────────────┘
                                         │
                                         ▼
                        [ Reproductor Híbrido HLSPlayerModal ]
                        - Motor Hls.js optimizado
                        - Proxy Anti-CORS (/api/v1/proxy/stream)
```

---

## 3. Arquitectura Híbrida de Scrapers (Strategy Pattern)

Ubicado en `server/scrapers/`, el sistema desacopla la lógica de extracción mediante el patrón Strategy y Factory:

```text
server/scrapers/
├── BaseAdapter.ts                  # Clase base abstracta (HTTP fetch, AbortController, extracción de embeds y streams)
├── ScraperManager.ts               # Registry & Factory que resuelve el adaptador adecuado para cada URL
├── ScraperManager.test.ts          # Pruebas unitarias de resolución de adaptadores
├── VideoExtraction.test.ts         # Pruebas unitarias de validación y extracción de streams
└── adapters/                       # 12 adaptadores registrados (modulares e intercambiables)
    ├── LaMovieAdapter.ts           # lamovie.org — películas/series; Filemoon/VOE/Mega/HLSWish/Goodstream
    ├── CinecalidadAdapter.ts       # cinecalidad.am — películas; m3u8 Goodstream + embeds VOE/Dood/Vimeos
    ├── TubePelisAdapter.ts         # tubepelis.com — películas; backend Byse cifrado (AES-256-GCM)
    ├── LatAnimeAdapter.ts          # latanime.org — animes; data-player Base64 + MP4Upload directo
    ├── TioAnimeAdapter.ts          # tioanime.com — animes; array `var videos`, embeds fiables priorizados
    ├── TioPlusAdapter.ts           # tioplus.app — películas/series; player propio + turboviplay HLS
    ├── VerAnimesAdapter.ts         # wwv.veranimes.net — animes; StreamWish/HQQ resueltos
    ├── AnimeFlvAdapter.ts          # www3.animeflv.net / jkanime / animeflv.or.at — parseo de JS y catálogos
    ├── ArchiveOrgAdapter.ts        # archive.org — API metadatos + streams MP4/HLS
    ├── TvMazeAdapter.ts            # tvmaze.com — series internacionales (solo metadatos/temporadas)
    ├── DirectStreamAdapter.ts      # streams directos (.m3u8, .mp4, .webm, Mux, Google Storage)
    └── GenericAdapter.ts           # fallback universal con IA semántica (PageClassifier, JSON-LD, OpenGraph)
```

> Informes técnicos por adaptador en `informes/` y pruebas de integración contra sitios reales en `tests/scrapers/`.

### Estado de validación E2E (2026-08-22)

| Adaptador | Estado | Notas |
|---|---|---|
| Cinecalidad | ✅ PASS | 6 streams (1 HLS directo + 5 embeds), proxy 200 |
| TubePelis | ✅ PASS | Decrypt Byse verificado con datos frescos, proxy 200 |
| TioPlus | ✅ PASS | Película y episodio OK, turboviplay HLS vía proxy 200 |
| LatAnime | ✅ PASS* | MP4Upload exige Referer propio → proxy lo fuerza por host |
| VerAnimes | ✅ PASS* | Fix detected_streams confirmado; embed StreamWish OK |
| TioAnime | ✅ PASS* | Streams efímeros/IP-dependientes van al final; embeds fiables primero |
| AnimeFLV / LaMovie | ✅ | Validados en sesiones anteriores |
| Archive.org / Directos | ✅ | Sanity checks previos |

`PASS*` = funciona end-to-end con mitigaciones ya aplicadas (limitaciones externas del sitio fuente).

### Funcionamiento del `ScraperManager`:
1. Recibe una URL o término de búsqueda.
2. Evalúa en orden de prioridad los adaptadores registrados mediante `canHandle(url)`.
3. Si la URL pertenece a un dominio especializado (ej. `animeflv.net`, `archive.org`, `tvmaze.com` o archivo directo `.m3u8`), delega la extracción a su adaptador exclusivo.
4. Si se trata de un sitio web desconocido, activa automáticamente el `GenericAdapter` como plan de respaldo para extraer metadatos OpenGraph, esquemas JSON-LD y reproductores iframes.
5. Permite también la selección explícita de un adaptador mediante `adapterId` desde el frontend o tareas del crawler.

---

## 4. Sistema Inteligente Anti-Duplicados

El motor de guardado (`server/showService.ts`) implementa una canalización de cuatro capas:

1. **Enriquecimiento Pre-Guardado**:
   Antes de escribir en la base de datos, el backend consulta AniList GraphQL / Jikan API para obtener el `mal_id`, título canónico, títulos en inglés/japonés, póster 4K, banner y sinopsis completa.

2. **Deduplicación por `mal_id` (Precisión 100%)**:
   Si el anime resultante posee un `mal_id` asignado por MyAnimeList/AniList, se consulta si ya existe en la base de datos (`prisma.show.findUnique({ where: { mal_id } })`).

3. **Deduplicación por Título Normalizado**:
   Si no se obtiene `mal_id`, se calcula una huella limpia del título (`normalizeTitle()`: minúsculas, sin tildes ni caracteres especiales). Se comprueba contra `normalized_title`, `japanese_title` y `english_title`.

4. **Fusión de Episodios**:
   Si se detecta un duplicado, **no se crea un nuevo registro**. La serie existente se actualiza con los episodios nuevos traídos del nuevo servidor/página que aún no estuvieran registrados.

---

## 5. Estructura del Repositorio

```
├── prisma/
│   └── schema.prisma          # Esquema relacional SQLite (Show, Episode, CrawlTask, WorkerSettingsStore)
├── server/
│   ├── db.ts                  # Cliente de Prisma ORM y normalizador de títulos
│   ├── metadataEngine.ts      # Enriquecedor multi-motor (AniList GraphQL 4K, Kitsu, Jikan MAL, TVMaze)
│   ├── pageClassifier.ts      # Clasificador semántico por scoring de señales de URL y DOM
│   ├── resolvers.ts           # Resolutor de reproductores embebidos (Zilla, MP4Upload, Voe.sx, Mega, etc.)
│   ├── router.ts              # Enrutador jerárquico de estrategias de extracción
│   ├── scrapers/              # Arquitectura Strategy de adaptadores desacoplados
│   │   ├── BaseAdapter.ts
│   │   ├── ScraperManager.ts
│   │   └── adapters/
│   ├── showService.ts         # Servicio CRUD con deduplicación por MAL ID y títulos normalizados
│   ├── taskWorker.ts          # Worker de tareas asíncronas persistido en base de datos
│   ├── types.ts               # Tipos e interfaces del backend
│   ├── universalScraper.ts    # Punto de entrada unificado que delega a ScraperManager
│   └── validator.ts           # Validador de salud de streams mediante HEAD/GET Range check
├── src/
│   ├── components/
│   │   ├── AdminPanel.tsx     # Smart Ingest, Crawler, tareas de Worker y gestión de catálogo
│   │   ├── HLSPlayerModal.tsx # Reproductor HLS.js con proxy anti-CORS y multiserver
│   │   └── ...                # Demás componentes UI
│   ├── utils/
│   │   ├── colorExtractor.ts  # Extracción de paleta de colores para glow dinámico
│   │   └── streamOptimizer.ts # Algoritmo de ranking y puntuación de servidores
│   └── App.tsx                # Orquestador principal de React 18
├── server.ts                  # Servidor Express, API REST, Proxy de Video y middleware Vite
├── .env.example               # Plantilla de variables de entorno
└── package.json               # Dependencias y scripts de npm
```

---

## 6. Módulos del Backend (`server/`)

### A. Servicio de Datos y Deduplicación (`server/showService.ts`)
- Orquesta las lecturas y escrituras en la base de datos SQLite con Prisma.
- Implementa `saveShowWithDeduplication()`, `getShowsFromDb()`, `getShowByIdFromDb()`, `deleteShowFromDb()` y `clearAllShowsFromDb()`.

### B. Motor de Metadatos Multi-API (`server/metadataEngine.ts`)
- **AniList 4K GraphQL (Principal)**: Obtiene imágenes en ultra alta resolución (WebP/JPG 4K), sinopsis completas limpias de tags HTML, puntuaciones, estado de emisión y título oficial en japonés.
- **Kitsu & Jikan MAL v4 (Fallbacks)**: Respaldo automático para animes clásicos o títulos no indexados en AniList.

### C. Worker de Tareas en Segundo Plano (`server/taskWorker.ts`)
- Guardado y recuperación de tareas de rastreo en la tabla `CrawlTask` de SQLite con serialización JSON automática.
- Ejecuta descubrimiento paginado, retrasos corteses (*polite rate limiting* con *jitter* anti-bloqueo) y deduplicación en lote.

### D. Validador y Resolutores de Video (`server/validator.ts` & `server/resolvers.ts`)
- Reconoce instantáneamente más de 20 hosts populares (*Streamwish, Filemoon, Mega, Voe, MP4Upload, YourUpload, Streamtape, Vidmoly, etc.*).
- Resuelve URLs directas `.m3u8` y `.mp4` para el reproductor HLS.js.

---

## 7. API REST Endpoints

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `GET` | `/api/v1/shows` | Obtiene el catálogo desde la base de datos con filtros de búsqueda y categoría |
| `GET` | `/api/v1/shows/:id` | Obtiene los detalles de una serie y su lista de episodios |
| `DELETE` | `/api/v1/shows/:id` | Elimina una serie y sus episodios de la base de datos |
| `GET` | `/api/v1/genres` | Lista todos los géneros disponibles combinando catálogo local y APIs |
| `GET` | `/api/v1/play/:episode_id` | Extractor Just-In-Time: resuelve streams en tiempo real para reproducción |
| `GET` | `/api/v1/proxy/stream` | Proxy de streaming con headers personalizados para evadir bloqueos CORS |
| `POST` | `/api/v1/catalog/analyze` | Analiza una URL fuente y devuelve la previsualización |
| `POST` | `/api/v1/catalog/import-show` | Importa una serie en la base de datos con sistema deduplicado |
| `POST` | `/api/v1/catalog/batch-import` | Importación masiva de múltiples series con deduplicación |
| `POST` | `/api/v1/catalog/crawl` | Inicia una tarea de rastreo en segundo plano persistida en DB |
| `GET` | `/api/v1/tasks/:id` | Consulta el estado y progreso en vivo de una tarea |
| `GET` | `/api/v1/worker/jobs` | Lista todos los trabajos del worker desde la base de datos |
| `POST` | `/api/v1/worker/jobs/:id/pause` | Pausa una tarea en ejecución |
| `POST` | `/api/v1/worker/jobs/:id/resume` | Reanuda una tarea pausada |
| `DELETE` | `/api/v1/worker/jobs/:id` | Elimina una tarea del historial del worker |
| `POST` | `/api/v1/catalog/reset-sample` | Vacía el catálogo de la base de datos por completo |

---

## 8. Guía de Instalación y Ejecución

### Prerrequisitos
- **Node.js**: v18+ (recomendado Node.js 20 o 24)
- **npm** o **bun**

### 1. Clonar e Instalar Dependencias

```bash
git clone https://github.com/Uziel660/finalnewtify.git
cd finalnewtify
npm install
```

### 2. Sincronizar Base de Datos con Prisma (Cero Configuración)

```bash
# Sincroniza las tablas en dev.db automáticamente
npm run db:push

# Genera los tipos de cliente de Prisma
npm run db:generate
```

### 3. Iniciar el Servidor en Desarrollo

```bash
npm run dev
```

El servidor unificado estará disponible en:
👉 **`http://localhost:3000`**

### 4. Compilación para Producción

```bash
# Verificar tipos de TypeScript
npm run lint

# Ejecutar tests unitarios
npm test

# Compilar frontend (Vite) y backend (esbuild)
npm run build

# Iniciar servidor en modo producción
npm start
```

---

## 9. Suites de Pruebas Automatizadas

El proyecto cuenta con suites de pruebas completas ejecutadas con **Vitest**:

```bash
npm test
```

### Cobertura de Tests:
- `src/utils/streamOptimizer.test.ts`: Algoritmo de puntuación, detección de calidad y ordenamiento de servidores (23 tests).
- `src/utils/colorExtractor.test.ts`: Extracción y conversión de colores RGB a RGBA (4 tests).
- `src/utils/titleNormalizer.test.ts`: Normalización de títulos crudos, claves de dedup, marcadores de temporada y guard anti-basura (36 tests).
- `server/metadataEngine.test.ts`: Limpieza de títulos, temporadas, metadatos y género en español (30+ tests).
- `server/scrapers/ScraperManager.test.ts`: Resolución de adaptadores por dominio y registro dinámico (8 tests).
- `server/scrapers/VideoExtraction.test.ts`: Extracción y validación de servidores de video (3 tests).
- `server/taskWorker.test.ts`: Creación, serialización SQLite, consulta y control de tareas del crawler.

**Total:** **87+ pruebas unitarias pasando.**

---

## 10. Subsistemas v4.2 (2026-08-24)

### 10.1 Configuración centralizada (`app.config.ts`)

Única fuente de verdad de host/puerto/CORS. La consumen el backend (`server.ts`), el reproductor (`proxiedUrl.ts`) y el optimizador (`streamOptimizer.ts`). Cambiar el puerto ahí + reiniciar = se propaga a todo. Orígenes CORS de túneles cloudflared también viven aquí.

### 10.2 Workers paralelos multi-catálogo (`server/taskWorker.ts`)

- Hasta `max_concurrent_jobs` (3 por defecto, ajustable en UI) barridos SIMULTÁNEOS; cola pendiente sin límite. `POST /api/v1/worker/jobs/:id/start` inicia cualquier pendiente saltándose la cola.
- Pipeline productor-consumidor por job: descubrimiento de páginas y guardado de obras corren SIMULTÁNEOS.
- Pausa fiable (`paused` ≠ `pending`), borrado con gracia, recuperación de huérfanos sin carreras (mutex + guards), reclamo atómico en BD.
- Paginación por sitio (9 patrones verificados) y auto-descubrimiento hasta el fin del catálogo en `full_catalog`, reanudable sin repetir páginas.
- ÍNDICE DE RE-ESCANEO: obras ya conocidas se verifican en modo ligero (~2-4s vs 10-30s) — solo se insertan episodios nuevos; sus streams se resuelven Just-In-Time.

### 10.3 Verificación automática (`server/verificationWorker.ts`)

Recorre el catálogo obra por obra (scope: todo / por plataformas / por categoría) re-colectando metadatos y detectando novedades en las plataformas elegidas (lo nuevo se importa con dedup; las conocidas reciben sync ligero de episodios por índice). Timer programable (minutos/horas/días/meses, ON/OFF persistente). Endpoints: `GET /api/v1/verification`, `POST .../config`, `POST .../run`.

### 10.4 Backfill + reparaciones (`server/metadataBackfill.ts`)

Completa SOLO campos vacíos con datos reales de TMDB/AniList (nunca defaults falsos). Repara descripciones truncadas (elipsis = débil → gana la completa de TMDB) y títulos con ruido estructural ("X Latino HD" → "X") sincronizando el MediaItem espejo, sin tocar claves de dedup. Si la BD está lenta, la escritura va al OUTBOX (`server/writeBuffer.ts` → `data/write-buffer.jsonl`) y un drenador la aplica sola cuando responde.

### 10.5 Dedup de secuelas + reconciliación (`server/reconcileCatalog.ts`)

- Importaciones nuevas con `tmdb_id` de una obra existente se multiplexan DENTRO de ella (`mergeSequelIntoTwin`): episodios con numeración continua + fuentes bajo su temporada.
- Reconciliación de secuelas YA guardadas: `POST /api/v1/catalog/reconcile-sequels` (dry-run por defecto) con guardas de similitud de títulos (Jaccard normalizado) para no fusionar tmdb_ids erróneos.
- Fusión manual de pares difíciles: `POST /api/v1/catalog/merge-works {keep_id, merge_id, dry_run?}`.
- El orden de plataformas al reproducir lo rigen las estadísticas de fuentes (SiteRating, tab Fuentes, reordenable con flechas).

### 10.6 Detección anti-bot (`server/utils/antiBot.ts`)

Cloudflare (cf-mitigated, "Just a moment", challenge-platform) y 429 repetidos se detectan en `BaseAdapter.fetchHtml` y en el worker. Banner rojo en la UI + auto-throttle por dominio (delay ×2→×4, expira en 10 min).

### 10.7 Editor de catálogo (`src/components/ShowEditModal.tsx`)

`PUT /api/v1/shows/:id` (todos los campos, recalcula claves canónicas si cambia el título), `POST /api/v1/shows/:id/refresh-streams` (re-resuelve servidores en background) y panel de plataformas donde está disponible el título (vía `play-multi` + `media_item_id` incluido en el GET).

### 10.8 Admin exclusivo en `/admin`

`main.tsx` enruta `/admin` → `AdminGate` (login contra `POST /api/v1/admin/login`; credenciales en `ADMIN_USER`/`ADMIN_PASS`). La página principal ya no expone acceso al panel.

### 10.9 Selector premium por plataforma

El backend adjunta `source_site` a cada stream (`/play`, `episode-servers`, `play-multi`); el reproductor agrupa y muestra el MEJOR servidor de cada plataforma primero, con badge de plataforma. Prioridad de plataformas reordenable con flechas (SiteRating, tab Fuentes). VOE/Mixdrop/filemoon descartados por lista negra doble (backend + cliente).

---

## 11. Novedades v5.0 — Serialización SQLite, Write-Buffer, Watchdog y ngrok (2026-08-25)

### 11.1 Write-Buffer Outbox (`server/writeBuffer.ts`)

Cuando SQLite está lenta o bloqueada (barridos pesados, múltiples workers), las escrituras se serializan en un archivo JSONL (`data/write-buffer.jsonl`) en lugar de escribir directo a la BD. Un drenador periódico (15s) aplica las operaciones una por una cuando la BD responde.

**Operaciones soportadas:**
| Tipo | Descripción |
|------|-------------|
| `show.update` | Actualización de metadatos (backfill/verificación) |
| `sourceLink.create` | Alta de fuente de video (dedup por unique constraint) |
| `mediaItem.create` | Alta de MediaItem (dedup por normalized_title+kind) |
| `mediaEpisode.upsert` | Alta de episodio (dedup por compuesto) |
| `crawlTask.update` | Actualización de estado de jobs del worker |

**Características:**
- Cada operación lleva un `fingerprint` para idempotencia.
- Reintentos automáticos (máx 5 intentos por operación).
- `sourceLink.create` resuelve el episode ID automáticamente: si recibe un `mediaItemId` placeholder, busca o crea el episodio correcto antes de insertar el SourceLink.
- El drenador arranca al boot del servidor y corre cada 15 segundos.

### 11.2 Serialización Total de Escrituras SQLite

Para evitar timeouts P1008 ("database is locked") durante barridos pesados, se implementó una estrategia de serialización completa:

| Parámetro | Valor | Efecto |
|-----------|-------|--------|
| `max_concurrent_jobs` | 1 | Solo 1 job simultáneo (antes 3) |
| `item_concurrency` | 1 | Solo 1 obra procesada a la vez por job |
| `page_concurrency` | 1 | Solo 1 página a la vez en descubrimiento |
| `busy_timeout` | 60000ms | Los writers esperan 60s en vez de fallar |
| `journal_mode` | WAL | Write-Ahead Logging para concurrencia |
| `synchronous` | NORMAL | Balance entre integridad y performance |
| Delay entre items | 2000ms | Pausa entre obras para drenar el WAL |

**Flujo de escrituras:**
```
Worker procesa obra → enqueueWrite() → data/write-buffer.jsonl
                                              ↓ (cada 15s)
                                    drainWriteBuffer() → SQLite
```

**Además:**
- `updateJobState` (estado de jobs) usa `enqueueWrite` en vez de escritura directa.
- `addLog` (logs del worker) se acumula en memoria (`logBuffers`) y flush cada 5s o al finalizar job.
- `syncEpisodeSources` (upsert + sourceLinks) se encola completo en el write buffer.

### 11.3 Watchdog Auto-Reparador (`server/watchdog.ts`)

Worker periódico que escanea la base de datos en busca de anomalías y las repara automáticamente.

**Anomalías detectadas:**
| Categoría | Descripción |
|-----------|-------------|
| `title` | Títulos basura / placeholder (vacíos, "Sin título", "test", etc.) |
| `metadata` | Descripciones faltantes o placeholder, posters faltantes |
| `orphan` | Obras sin episodios (catálogo fantasma) |
| `stuck_job` | Jobs fallidos o stuck en "running" por >30 min |
| `empty_show` | Fuentes huérfanas (SourceLinks sin MediaItem válido) |
| `duplicate` | Duplicados por normalized_title |

**Archivos:**
- `data/watchdog.config.json` — Configuración (enabled, interval_minutes, auto_fix, title_patterns_blacklist)
- `data/watchdog-reports.json` — Últimos 50 hallazgos con timestamp y severidad
- `data/WATCHDOG_ALERT.json` — Alerta crítica para el asistente (opencode)

**Endpoints API:**
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `GET` | `/api/v1/watchdog` | Estado actual del watchdog |
| `GET` | `/api/v1/watchdog/config` | Obtener configuración |
| `POST` | `/api/v1/watchdog/config` | Actualizar configuración |
| `POST` | `/api/v1/watchdog/run` | Ejecutar escaneo manual |
| `GET` | `/api/v1/watchdog/reports` | Últimos reportes |
| `GET` | `/api/v1/watchdog/alert` | Alerta crítica (si existe) |
| `POST` | `/api/v1/watchdog/alert/clear` | Marcar alerta como procesada |

**Auto-reparación:**
- Títulos basura → reemplaza por `base_normalized_title` del show.
- Jobs stuck → marca como `error` con mensaje descriptivo.
- Jobs fallidos → resetea a `pending` para reintentar.

### 11.4 Watchdog Runner Standalone (`tools/watchdog-runner.ts`)

Runner independiente que puede ejecutarse fuera del servidor:

```bash
npx tsx tools/watchdog-runner.ts          # Loop continuo
npx tsx tools/watchdog-runner.ts --once   # Una sola pasada
```

Si detecta anomalías críticas, invoca automáticamente `opencode run` con el contexto del error para que el asistente revise y repare.

### 11.5 Túnel ngrok para Acceso Externo

 ngrok está configurado para exponer el servidor local vía un dominio público estable:

- **Dominio:** `prehensile-hyperactively-zara.ngrok-free.dev`
- **Backend:** `http://localhost:3000`
- **Binario:** `C:\Users\Uziel\AppData\Roaming\npm\node_modules\ngrok\bin\ngrok.exe` (v3.39.11)

El dominio ngrok ya está incluido en la lista de orígenes CORS permitidos en `app.config.ts`. Para iniciar:

```bash
ngrok http 3000 --domain=prehensile-hyperactively-zara.ngrok-free.dev
```

### 11.6 Configuración Centralizada de Red (`app.config.ts`)

Única fuente de verdad de host/puerto/CORS. La consumen el backend (`server.ts`), el reproductor (`proxiedUrl.ts`) y el optimizador (`streamOptimizer.ts`). Incluye orígenes de túneles Cloudflare y ngrok.

### 11.7 Plyr Player Modal (`src/components/PlyrPlayerModal.tsx`)

Reproductor moderno basado en Plyr con:
- Soporte HLS vía Hls.js
- Selección de calidad
- UI limpia y responsive
- Integración con el sistema de servidores multiplex

### 11.8 Repositorio Git Limpio

Los archivos generados en runtime (WAL, SHM, JSONL del write buffer, alertas del watchdog) están excluidos del repositorio vía `.gitignore` para evitar problemas de tamaño en GitHub (>100MB):

```
prisma/dev.db-wal
prisma/dev.db-shm
data/write-buffer.jsonl
data/WATCHDOG_ALERT.json
data/watchdog-reports.json
```

---

## 12. Resumen de Cambios por Versión

| Versión | Fecha | Cambios Principales |
|---------|-------|---------------------|
| v5.0 | 2026-08-25 | Write-Buffer outbox, serialización SQLite total, watchdog auto-reparador, túnel ngrok, Plyr player |
| v4.2 | 2026-08-24 | Workers paralelos, verificación automática, reconciliación de secuelas, editor catálogo, admin `/admin` |
| v4.1 | 2026-08-22 | Arquitectura híbrida de scrapers (12 adaptadores), dedup multi-API,Continue Watching |
| v4.0 | 2026-08-20 | Upgrade base, Prisma ORM, tests Vitest, SSRF fixes |
