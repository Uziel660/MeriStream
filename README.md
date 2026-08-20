# 🎬 NITIFLIX / VOIDSTREAM — FULL-STACK TYPESCRIPT MEDIA PLATFORM

> **Versión del Sistema:** 4.0.0 (Persistencia PostgreSQL + Prisma ORM + Sistema Anti-Duplicados Multi-API + Enriquecimiento GraphQL AniList 4K + Clasificación Semántica + Extracción Just-In-Time)
> **Estado:** 100% Funcional de Extremo a Extremo (Base de datos PostgreSQL 17, Prisma ORM, Sistema Anti-Duplicados por MAL ID y Títulos Normalizados, Scraping Nativo, Clasificación Semántica de Páginas, Resolutores Embebidos, Validador de Streams, Enriquecimiento Multifuente con AniList/Kitsu/MAL, Catálogo Interactivo con Estado Reactivo de Importación, Reproductor Híbrido HLS/Embed con Proxy Anti-CORS y Worker de Tareas Persistente).
> **Stack:** Node.js (Express + TypeScript + Cheerio + Prisma ORM + PostgreSQL 17) + React 18 (TypeScript + Vite) + Tailwind CSS + Lucide Icons + Hls.js.

---

## 📋 Índice de Contenidos

1. [Visión y Filosofía](#1-visión-y-filosofía-del-proyecto)
2. [Arquitectura Unificada (TypeScript + PostgreSQL + Prisma)](#2-arquitectura-unificada-typescript--postgresql--prisma)
3. [Sistema Inteligente Anti-Duplicados](#3-sistema-inteligente-anti-duplicados)
4. [Estructura del Repositorio](#4-estructura-del-repositorio)
5. [Módulos del Backend (`server/`)](#5-módulos-del-backend-server)
6. [Frontend y Componentes Clave (`src/`)](#6-frontend-y-componentes-clave-src)
7. [API REST Endpoints](#7-api-rest-endpoints)
8. [Guía de Instalación y Configuración](#8-guía-de-instalación-y-configuración)

---

## 1. Visión y Filosofía del Proyecto

Nitiflix es una plataforma de streaming personal, catálogo multimedia interactivo y motor de ingesta universal con estética cinematográfica de alta gama estilo Netflix / Stremio.

### Principios Fundamentales

1. **Persistencia PostgreSQL y Cero Contenido Demo:**
   La aplicación funciona sobre una base de datos relacional PostgreSQL en vivo a través de Prisma ORM. Se inicia con una videoteca limpia lista para ser alimentada mediante ingesta universal o rastreo en segundo plano.

2. **Deduplicación Estricta Multi-API:**
   Incluso si se importan animes o series desde diferentes sitios web (AnimeFLV, JKanime, Cuevana, etc.), el sistema verifica la obra contra **AniList GraphQL** y **Jikan / MyAnimeList (MAL)** antes de guardar. Identifica si el título o su `mal_id` ya existen en la base de datos y **fusiona los episodios** en la misma ficha en lugar de crear registros duplicados.

3. **Modelo Just-In-Time (JIT) + Catálogo Desacoplado:**
   En el instante en que el usuario reproduce un episodio o película, el motor analiza la fuente en tiempo real, decodifica streams ocultos en Base64/scripts empaquetados, resuelve servidores de video (Zilla, Mega, Voe, MP4Upload, StreamTape, etc.) y genera una lista ordenada de calidades y servidores listos para reproducción nativa HLS (.m3u8), MP4 directo o iframe sandbox seguro.

---

## 2. Arquitectura Unificada (TypeScript + PostgreSQL + Prisma)

Todo el ecosistema corre bajo un **único runtime Node.js/TypeScript** conectado a **PostgreSQL**:

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
             [ YA EXISTE EN POSTGRES ]             [ ES OTRA OBRA NUEVA ]
            (Fusiona nuevos episodios)            (Inserta Show + Episodes)
                       │                                  │
                       └────────────────┬─────────────────┘
                                        │
                                        ▼
                         ┌──────────────────────────────┐
                         │   BASE DE DATOS POSTGRESQL   │
                         │    (Prisma ORM - nitiflix)   │
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
                      │ - StrategyRouter (Prioridades)     │
                      │ - EmbedResolvers (Voe/Zilla/Mega)  │
                      │ - MediaValidator (HEAD / Range 0-1)│
                      └─────────────────┬──────────────────┘
                                        │
                                        ▼
                       [ Reproductor Híbrido HLSPlayerModal ]
                       - Motor Hls.js optimizado
                       - Proxy Anti-CORS (/api/v1/proxy/stream)
```

---

## 3. Sistema Inteligente Anti-Duplicados

El motor de guardado (`server/showService.ts`) implementa una canalización de cuatro capas:

1. **Enriquecimiento Pre-Guardado**:
   Antes de escribir en la base de datos, el backend consulta AniList GraphQL / Jikan API para obtener el `mal_id`, título canónico, títulos en inglés/japonés, póster 4K, banner y sinopsis completa.

2. **Deduplicación por `mal_id` (Precisión 100%)**:
   Si el anime resultante posee un `mal_id` asignado por MyAnimeList/AniList, se consulta si ya existe en PostgreSQL (`prisma.show.findUnique({ where: { mal_id } })`).

3. **Deduplicación por Título Normalizado**:
   Si no se obtiene `mal_id`, se calcula una huella limpia del título (`normalizeTitle()`: minúsculas, sin tildes ni caracteres especiales). Se comprueba contra `normalized_title`, `japanese_title` y `english_title`.

4. **Fusión de Episodios**:
   Si se detecta un duplicado, **no se crea un nuevo registro**. La serie existente se actualiza con los episodios nuevos traídos del nuevo servidor/página que aún no estuvieran registrados.

---

## 4. Estructura del Repositorio

```
├── prisma/
│   └── schema.prisma          # Esquema relacional PostgreSQL (Show, Episode, CrawlTask, WorkerSettingsStore)
├── server/
│   ├── db.ts                  # Cliente de Prisma ORM y normalizador de títulos
│   ├── metadataEngine.ts      # Enriquecedor multi-motor (AniList GraphQL 4K, Kitsu, Jikan MAL, TVMaze)
│   ├── pageClassifier.ts      # Clasificador semántico por scoring de señales de URL y DOM
│   ├── resolvers.ts           # Resolutor de reproductores embebidos (Zilla Networks, MP4Upload, Voe.sx, Mega, etc.)
│   ├── router.ts              # Enrutador jerárquico de estrategias de extracción
│   ├── showService.ts         # Servicio CRUD con deduplicación por MAL ID y títulos normalizados
│   ├── taskWorker.ts          # Worker de tareas asíncronas persistido en PostgreSQL
│   ├── types.ts               # Tipos e interfaces del backend
│   ├── universalScraper.ts    # Scraper universal integrando búsqueda, tarjetas e imágenes de AnimeFLV
│   └── validator.ts           # Validador de salud de streams mediante HEAD/GET Range check
├── src/
│   ├── components/
│   │   ├── AdminPanel.tsx     # Smart Ingest, Crawler, tareas de Worker y gestión de catálogo
│   │   ├── HLSPlayerModal.tsx # Reproductor HLS.js con proxy anti-CORS y multiserver
│   │   └── ...                # Demás componentes UI
│   └── App.tsx                # Orquestador principal de React 18
├── server.ts                  # Servidor Express, API REST, Proxy de Video y middleware Vite
├── .env                       # Configuración local (DATABASE_URL, PORT)
└── package.json               # Dependencias (Express, React, Prisma, Tailwind)
```

---

## 5. Módulos del Backend (`server/`)

### A. Servicio de Datos y Deduplicación (`server/showService.ts`)
- Orquesta las lecturas y escrituras en la base de datos PostgreSQL.
- Implementa `saveShowWithDeduplication()`, `getShowsFromDb()`, `getShowByIdFromDb()`, `deleteShowFromDb()` y `clearAllShowsFromDb()`.

### B. Motor de Metadatos Multi-API (`server/metadataEngine.ts`)
- **AniList 4K GraphQL (Principal)**: Obtiene imágenes en ultra alta resolución (WebP/JPG 4K), sinopsis completas limpias de tags HTML, puntuaciones, estado de emisión y título oficial en japonés.
- **Kitsu & Jikan MAL v4 (Fallbacks)**: Respaldo automático para animes clásicos o títulos no indexados en AniList.

### C. Scraper Universal (`server/universalScraper.ts`)
- Soporta búsquedas directas en AnimeFLV extrayendo las imágenes originales del catálogo para previsualización en el AdminPanel.
- Extracción de episodios embebidos `.animeflv-episodes-data` y selectores DOM genéricos.

### D. Worker de Tareas en Segundo Plano (`server/taskWorker.ts`)
- Guardado y recuperación de tareas de crawl en la tabla `CrawlTask` de PostgreSQL.
- Procesa cada ítem descubierto ejecutando deduplicación automática y enriquecimiento AniList.

---

## 6. API REST Endpoints

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `GET` | `/api/v1/shows` | Obtiene el catálogo desde PostgreSQL con filtros de búsqueda y categoría |
| `GET` | `/api/v1/shows/:id` | Obtiene los detalles de una serie y su lista de episodios |
| `DELETE` | `/api/v1/shows/:id` | Elimina una serie y sus episodios de PostgreSQL |
| `GET` | `/api/v1/genres` | Lista todos los géneros disponibles |
| `GET` | `/api/v1/play/:episode_id` | Extractor Just-In-Time: resuelve streams en tiempo real para reproducción |
| `GET` | `/api/v1/proxy/stream` | Proxy de streaming con headers personalizados para evadir bloqueos CORS |
| `POST` | `/api/v1/catalog/analyze` | Analiza una URL fuente y devuelve la previsualización |
| `POST` | `/api/v1/catalog/import-show` | Importa una serie en PostgreSQL con sistema deduplicado |
| `POST` | `/api/v1/catalog/batch-import` | Importación masiva de múltiples series con deduplicación |
| `POST` | `/api/v1/catalog/crawl` | Inicia una tarea de rastreo en segundo plano persistida en DB |
| `GET` | `/api/v1/tasks/:id` | Consulta el estado y progreso en vivo de una tarea |
| `GET` | `/api/v1/worker/jobs` | Lista todos los trabajos del worker desde PostgreSQL |
| `POST` | `/api/v1/catalog/reset-sample` | Vacía la base de datos PostgreSQL por completo |

---

## 7. Guía de Instalación y Configuración

### Prerrequisitos
- **Node.js**: v18+ (recomendado Node.js 20 o 24)
- **PostgreSQL**: v14+ (recomendado PostgreSQL 17 corriendo en `localhost:5432`)

### 1. Variables de Entorno (`.env`)

Asegúrate de tener un archivo `.env` en la raíz con la cadena de conexión a PostgreSQL:

```env
DATABASE_URL="postgresql://postgres:nitiflix123@localhost:5432/nitiflix?schema=public"
PORT=3000
NODE_ENV=development
```

### 2. Sincronizar Base de Datos con Prisma

```bash
# Crear las tablas en PostgreSQL e implementar la estructura relacional
npx prisma db push

# Generar el cliente de Prisma
npx prisma generate
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

# Compilar frontend (Vite) y backend (esbuild)
npm run build

# Iniciar servidor compilado
npm start
```

---

**Última actualización:** 2026-08-20
**Versión de Producción:** 4.0.0
**Mantenedor:** Uziel660
