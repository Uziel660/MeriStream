# 🎬 NITIFLIX / VOIDSTREAM — FULL-STACK MEDIA & STREAMING PLATFORM

> **Versión del Sistema:** 4.1.0 (Arquitectura Híbrida de Scrapers Strategy Pattern + Base de Datos SQLite/Prisma Cero-Configuración + Sistema Anti-Duplicados Multi-API + Enriquecimiento GraphQL AniList 4K + Extracción de Video Just-In-Time)
> **Estado:** 100% Funcional de Extremo a Extremo (Base de datos SQLite persistente con Prisma ORM, Arquitectura de Scrapers desacoplada con Adaptadores dedicados y Fallback Semántico, Resolutores de Video Embed multiserver, Validador de Streams, Enriquecimiento Multifuente con AniList/Kitsu/MAL, Catálogo Interactivo con Estado Reactivo de Importación, Reproductor Híbrido HLS/Embed con Proxy Anti-CORS y Worker de Tareas Persistente).
> **Stack:** Node.js (Express + TypeScript + Cheerio + Prisma ORM + SQLite) + React 18 (TypeScript + Vite) + Tailwind CSS + Lucide Icons + Hls.js + Vitest.

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
└── adapters/
    ├── AnimeFlvAdapter.ts          # Adaptador específico para AnimeFLV / JKanime (parseo de JS y catálogos)
    ├── ArchiveOrgAdapter.ts        # Adaptador para Internet Archive (API de metadatos + streams MP4/HLS)
    ├── TvMazeAdapter.ts            # Adaptador para TVMaze (series internacionales y temporadas)
    ├── DirectStreamAdapter.ts      # Adaptador para streams directos (.m3u8, .mp4, .webm, Mux, Google Storage)
    └── GenericAdapter.ts           # Adaptador fallback universal con IA semántica (PageClassifier, JSON-LD, OpenGraph)
```

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
- `server/metadataEngine.test.ts`: Limpieza de títulos y consultas de metadatos (7 tests).
- `server/scrapers/ScraperManager.test.ts`: Resolución de adaptadores por dominio y registro dinámico (8 tests).
- `server/scrapers/VideoExtraction.test.ts`: Extracción y validación de servidores de video (3 tests).
- `server/taskWorker.test.ts`: Creación, serialización SQLite, consulta y control de tareas del crawler (1 test).

**Total:** **46 pruebas unitarias pasando al 100%**.
