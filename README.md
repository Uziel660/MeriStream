# 🎬 NITIFLIX / VOIDSTREAM — FULL-STACK TYPESCRIPT MEDIA PLATFORM

> **Versión del Sistema:** 3.0.0 (Arquitectura Unificada TypeScript Full-Stack + Extracción Universal Just-In-Time)  
> **Estado:** 100% Funcional de Extremo a Extremo (Scraping nativo, Enriquecimiento Multifuente, Catálogo Semántico, Reproductor Híbrido HLS/Embed con Proxy Anti-CORS y Worker de Tareas en Segundo Plano).  
> **Stack:** Node.js (Express + TypeScript + Cheerio + Axios) + React 18 (TypeScript + Vite) + Tailwind CSS + Lucide Icons + Hls.js.

---

## 📋 Índice de Contenidos

1. [Visión y Filosofía](#1-visión-y-filosofía-del-proyecto)
2. [Arquitectura Unificada (TypeScript Full-Stack)](#2-arquitectura-unificada-typescript-full-stack)
3. [Estructura del Repositorio](#3-estructura-del-repositorio)
4. [Módulos del Backend (`server/`)](#4-módulos-del-backend-server)
5. [Frontend y Componentes Clave (`src/`)](#5-frontend-y-componentes-clave-src)
6. [API REST Endpoints](#6-api-rest-endpoints)
7. [Guía de Instalación y Ejecución](#7-guía-de-instalación-y-ejecución)
8. [Configuraciones Avanzadas](#8-configuraciones-avanzadas)

---

## 1. Visión y Filosofía del Proyecto

Nitiflix es una plataforma de streaming personal, catálogo multimedia interactivo y motor de ingesta universal con estética de alta gama estilo Netflix / Stremio.

### Principio Fundamental: "Modelo Just-In-Time + Catálogo Desacoplado"

En lugar de almacenar enlaces de video que expiran rápidamente por tokens temporales (TTL) de los CDN, el sistema opera con dos motores coordinados en **TypeScript**:

1. **Indexador y Catálogo Semántico (Batch & On-Demand):**  
   Extrae metadatos, sinopsis, pósteres en alta resolución, banners, géneros, temporadas y episodios. Enriquece la información consultando automáticamente APIs de metadatos (Jikan / MyAnimeList, Kitsu, AniList y TMDB).

2. **Extractor de Video Just-In-Time:**  
   En el instante en que el usuario reproduce un episodio o película, el motor analiza la fuente en tiempo real, decodifica streams ocultos en Base64/scripts empaquetados, resuelve servidores de video (Zilla, Mega, Voe, MP4Upload, StreamTape, etc.) y genera una lista ordenada de calidades y servidores listos para reproducción nativa HLS (.m3u8), MP4 directo o iframe sandbox seguro.

---

## 2. Arquitectura Unificada (TypeScript Full-Stack)

Todo el ecosistema corre bajo un **único runtime Node.js/TypeScript**, eliminando la necesidad de dependencias externas de Python, entornos virtuales o puertos desincronizados:

```
                              [ ENTRADA DE USUARIO ]
             (Búsqueda, Navegación de Catálogo o URL en Smart Ingest)
                                       │
                                       ▼
                       [ POST /api/v1/catalog/analyze ]
                                       │
                                       ▼
                     ┌────────────────────────────────────┐
                     │     Universal Scraper Engine       │
                     │  (server/universalScraper.ts)      │
                     └─────────────────┬──────────────────┘
                                       │
                      ┌────────────────┴────────────────┐
                      ▼                                 ▼
             [ ES UNA COLECCIÓN ]             [ ES UNA FICHA DE SERIE ]
          (Directorio / Resultados)           (Serie / Película con episodios)
                      │                                 │
                      ▼                                 ▼
             parseCollectionPage()              parseDetailPage()
             - Extrae tarjetas y enlaces        - Extrae lista de episodios
             - Resuelve paginación              - Enriquece metadatos (MAL/Kitsu)
                      │                                 │
                      ▼                                 ▼
             POST /api/v1/catalog/crawl       POST /api/v1/catalog/import-show
             (Worker en background)           (Persiste en base de datos local)
                      │                                 │
                      └────────────────┬────────────────┘
                                       │
                                       ▼
                          [ BASE DE DATOS JSON/PERSIST ]
                            (Shows, Episodes, Tasks)
                                       │
                                       ▼
                      [ FRONTEND REACT (Catálogo / Home) ]
                      - UnifiedHeader (Búsqueda + Filtros + Tags)
                      - HeroBanner con AmbientGlow dinámico
                      - BentoCollection & MediaRow interactivos
                      - Continuar viendo con progreso persistido
                                       │
                                       ▼ (Usuario: "Play Episodio X")
                        [ GET /api/v1/play/:episode_id ]
                                       │
                                       ▼
                     ┌────────────────────────────────────┐
                     │   Extractor Just-In-Time (JIT)     │
                     │ - Decodificación Base64 / DomPack  │
                     │ - Resolvers HLS / MP4 / Embeds     │
                     │ - Ordenamiento por calidad/estabilidad │
                     └─────────────────┬──────────────────┘
                                       │
                                       ▼
                      [ Reproductor Híbrido HLSPlayerModal ]
                      - Motor Hls.js optimizado (StreamOptimizer)
                      - Fallback instantáneo multiserver
                      - Proxy Anti-CORS integrado (/api/v1/proxy/stream)
                      - Atajos de teclado, Picture-in-Picture y Mini-Player
```

---

## 3. Estructura del Repositorio

```
├── server/
│   ├── metadataEngine.ts      # Enriquecedor de metadatos (Jikan MAL, Kitsu, TMDB, AniList)
│   ├── taskWorker.ts          # Worker de tareas asíncronas de crawling e importación masiva
│   ├── types.ts               # Tipos e interfaces de datos del backend
│   └── universalScraper.ts    # Scraper universal con parsers de colecciones y fichas de video
├── src/
│   ├── api/
│   │   └── client.ts          # Cliente API tipado con axios para consumo del backend
│   ├── components/
│   │   ├── AdminPanel.tsx     # Centro de control: Smart Ingest, Crawler, Jobs y Monitor
│   │   ├── AllCategoriesModal.tsx # Explorador completo de géneros y taxonomías
│   │   ├── AmbientGlow.tsx    # Fondo dinámico ambiental con color extraction del póster
│   │   ├── BentoCollection.tsx # Cuadrícula bento interactiva para colecciones destacadas
│   │   ├── ContinueWatching.tsx # Fila de reanudación con progreso en tiempo real
│   │   ├── HeroBanner.tsx     # Billboard cinematográfico con reproducción rápida
│   │   ├── HLSPlayerModal.tsx # Reproductor de video avanzado (HLS.js, Multiserver, MiniPlayer)
│   │   ├── MediaCard.tsx      # Tarjeta con zoom, metadatos enriquecidos y quick actions
│   │   ├── MediaDetailsModal.tsx # Ficha técnica estilo Netflix con selector de temporadas
│   │   ├── MediaRow.tsx       # Carrusel horizontal adaptable
│   │   └── UnifiedHeader.tsx  # Barra de navegación unificada con búsqueda, filtros y tags
│   ├── hooks/
│   │   ├── useDebouncedValue.ts # Hook de debounce para búsquedas en tiempo real
│   │   └── useTaskPolling.ts    # Hook de sondeo reactivo de tareas en segundo plano
│   ├── utils/
│   │   ├── colorExtractor.ts  # Extractor de paletas de color dominantes desde pósteres
│   │   └── streamOptimizer.ts # Optimizador y configurador de buffers y niveles para HLS.js
│   ├── App.tsx                # Orquestador principal de vistas, modales y estado global
│   ├── index.css              # Configuración Tailwind CSS y animaciones
│   ├── main.tsx               # Punto de entrada de React 18
│   └── types.ts               # Tipos TypeScript compartidos en todo el frontend
├── server.ts                  # Servidor Express, API REST, Proxy de Video y middleware Vite
├── vite.config.ts             # Configuración del empaquetador Vite y Tailwind
├── package.json               # Dependencias unificadas (Express, React, HLS, Lucide, Tailwind)
└── metadata.json              # Metadatos del applet y configuración de entorno
```

---

## 4. Módulos del Backend (`server/`)

### A. Scraper Universal (`server/universalScraper.ts`)
- **Detección Semántica**: Clasifica páginas de streaming entre colecciones/directorios y fichas de detalle.
- **Extracción de Streams Ocultos**: Desofusca scripts JavaScript, decodifica atributos Base64 (`data-src`, `data-player`, etc.) y extrae reproductores de Zilla, MP4Upload, Voe, Mega, StreamTape, YourUpload y más.
- **Generación de Servidores Alternativos**: Retorna `all_available_streams` para permitir conmutación transparente en el reproductor.

### B. Motor de Metadatos (`server/metadataEngine.ts`)
- Normaliza nombres eliminando prefijos/sufijos ("Ver", "Sub Español", "HD", etc.).
- Consulta APIs públicas de anime y cine (Jikan / MyAnimeList v4, Kitsu API, etc.).
- Enriquece con pósteres 4K, sinopsis completas, puntuaciones, estado de emisión y banners.

### C. Worker de Tareas en Segundo Plano (`server/taskWorker.ts`)
- Cola de ejecución para crawling de catálogos masivos.
- Control de concurrencia y reintentos automáticos.
- Métricas en tiempo real de páginas rastreadas, series añadidas y episodios indexados.

### D. Servidor Principal & Proxy Anti-CORS (`server.ts`)
- Servidor Express con persistencia de base de datos local en JSON (`data/db.json`).
- Proxy de streaming con retransmisión de encabezados (`Referer`, `Origin`, `User-Agent`) para saltar restricciones CORS de CDNs protegidos.

---

## 5. Frontend y Componentes Clave (`src/`)

- **`HLSPlayerModal.tsx`**:
  - Reproductor con soporte para streams nativos `.m3u8` (HLS.js) e iframes con sandbox seguro.
  - Selector de servidores en vivo con detección automática de fallos y cambio inteligente de fuente.
  - Selector de calidad/resolución (1080p, 720p, 480p, Auto), velocidad de reproducción y atajos de teclado (Espacio, Flechas, F para pantalla completa, M para mute).
  - Modo Mini-Player flotante y Picture-in-Picture.
  - Almacenamiento y sincronización de progreso de reproducción (`currentTime` y porcentaje visto).

- **`UnifiedHeader.tsx`**:
  - Barra de navegación moderna con buscador en tiempo real, selector de categorías y chips de géneros con conteos dinámicos.

- **`ContinueWatching.tsx`**:
  - Fila interactiva de reanudación rápida con barra de progreso visual y botón de reanudar al instante.

- **`AdminPanel.tsx`**:
  - Herramienta **Smart Ingest**: pega una URL para analizarla, previsualizar su contenido e importarla con un solo clic.
  - Crawler masivo con selector de profundidad de páginas.
  - Monitor en vivo de tareas activas, completadas o fallidas.
  - Gestor de catálogo con búsqueda y eliminación de series.

---

## 6. API REST Endpoints

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `GET` | `/api/v1/shows` | Obtiene el catálogo de series/películas con filtros de búsqueda, categoría y género |
| `GET` | `/api/v1/shows/:id` | Obtiene los detalles de una serie y su lista completa de episodios |
| `DELETE` | `/api/v1/shows/:id` | Elimina una serie y sus episodios de la base de datos |
| `GET` | `/api/v1/genres` | Lista todos los géneros disponibles y conteo de series asociadas |
| `GET` | `/api/v1/play/:episode_id` | Ejecuta el extractor Just-In-Time y devuelve la lista de streams y servidores |
| `GET` | `/api/v1/proxy/stream` | Proxy de streaming con headers personalizados para evadir bloqueos CORS |
| `POST` | `/api/v1/catalog/analyze` | Analiza una URL fuente y devuelve la previsualización de la serie o colección |
| `POST` | `/api/v1/catalog/import-show` | Importa y persiste una serie analizada en la base de datos |
| `POST` | `/api/v1/catalog/batch-import` | Importación masiva de múltiples series |
| `POST` | `/api/v1/catalog/crawl` | Inicia una tarea de rastreo y crawling en segundo plano |
| `GET` | `/api/v1/worker/jobs` | Consulta la lista de trabajos y estado del worker |
| `POST` | `/api/v1/worker/jobs/:id/cancel`| Cancela un trabajo en ejecución |
| `GET` / `POST` | `/api/v1/worker/settings` | Consulta o actualiza los ajustes de concurrencia y límites del worker |

---

## 7. Guía de Instalación y Ejecución

### Prerrequisitos
- Node.js 18+ (o superior)
- npm 9+ (o superior)

### Instalación en un solo paso

```bash
# 1. Clonar el repositorio y acceder al directorio
cd /workspaces/NEWNETIFY

# 2. Instalar todas las dependencias
npm install

# 3. Iniciar el servidor en modo desarrollo (Backend Express + Frontend Vite)
npm run dev
```

El sistema iniciará automáticamente el backend y el frontend en:
👉 **`http://localhost:3000`**

### Compilación para Producción

```bash
# Compilar frontend y empaquetar backend
npm run build

# Iniciar servidor de producción
npm start
```

---

## 8. Configuraciones Avanzadas

### Variables de Entorno (Opcional)
Puedes crear un archivo `.env` en la raíz del proyecto para personalizar parámetros del servidor:

```env
# Puerto del servidor (Por defecto: 3000)
PORT=3000

# Clave de API de TMDB (Opcional, para enriquecimiento adicional de películas/series occidentales)
TMDB_API_KEY=

# User Agent personalizado para el Scraper
SCRAPER_USER_AGENT="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
```

---

**Última actualización:** 2026-08-20  
**Mantenedor:** Uziel660
