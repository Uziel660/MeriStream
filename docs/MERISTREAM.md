# MeriStream — Arquitectura y API

Este archivo es la **fuente técnica principal** del proyecto. Si el código y otro documento difieren, manda el código actual y este documento debe actualizarse.

## 1. Objetivo

MeriStream es una plataforma personal tipo Netflix con catálogo unificado, múltiples fuentes por obra/episodio y reproductor interno. El catálogo no debe depender de una web concreta: los sitios externos son **providers de fuentes**, no dueños de la identidad del contenido.

Prioridades de idioma:

- **Anime:** japonés + subtítulos español primero; audio español después; japonés + subtítulos inglés como fallback.
- **Películas/series:** inglés y español casi al mismo nivel; se premian subtítulos ES/EN independientes.

## 2. Arquitectura actual

```text
TMDB / AniList / MAL
        │
        ▼
 identidad + metadata
        │
        ▼
MediaItem
   │
   └── MediaEpisode
          │
          └── SourceLink[]
                 ▲
                 │
       crawlers / workers / providers
                 │
                 ▼
       ResolutionCoordinator
                 │
          EmbedResolvers
                 │
       MP4 / HLS / DASH / proxy
                 │
                 ▼
          reproductor interno
```

Se conserva el core JIT existente:

- `MediaItem -> MediaEpisode -> SourceLink`.
- `ResolutionCoordinator`.
- `PlaybackSessionStore`.
- `DeliveryPlanner`.
- `EmbedResolvers`.
- workers/crawlers para ingestión, actualización y salud.

El modelo legacy `Show/Episode` sigue existiendo por compatibilidad, pero la dirección del proyecto es que `MediaItem/MediaEpisode/SourceLink` sea el modelo canónico único.

## 3. Identidad de contenido

### Películas y series

**TMDB ID** es la identidad externa principal.

El matching no puede depender solo del título que publique una web. El flujo es:

```text
título crudo
  -> normalización
  -> año / tipo / temporada / episodio
  -> IDs fuertes disponibles
  -> aliases y títulos alternativos
  -> búsqueda TMDB
  -> score de confianza
  -> MediaItem canónico
```

Orden de confianza:

1. TMDB ID directo.
2. IMDb/MAL/AniList u otro ID externo verificable.
3. título exacto/alias + año + tipo.
4. similitud textual con señales estructurales.
5. si la confianza es baja: no auto-vincular.

`metadataEngine.ts` ya implementa normalización, comparación por tokens, año, tipo y ranking de candidatos TMDB. Los providers deben aportar IDs fuertes siempre que los tengan.

### Anime

TMDB sirve para identidad global y AniList/MAL para enriquecer anime:

- títulos romaji/english/native;
- géneros;
- score;
- relaciones SEQUEL/PREQUEL;
- temporadas/partes;
- IDs AniList/MAL.

## 4. Providers

La política central vive en:

`server/providers/providerPolicy.ts`

Ahí se define:

- prioridad;
- rol (`primary`, `secondary`, `fallback`, `metadata`);
- estado (`active`, `maintained`, `legacy`, `experimental`);
- idiomas esperados;
- rating por defecto.

No se debe duplicar el orden de providers en adapters, UI y servicios distintos.

Las URLs de catálogos completos viven en:

`server/providers/ingestionRegistry.ts`

Ese archivo es la única lista operativa usada por `npm run ingest:all`.

### Prioridad inicial

#### Anime

1. `animeav1`
2. `animeflv`
3. `jkanime`
4. `hianimes`
5. `latanime`, `tioanime`, `veranimes` como fallback

#### Películas/series

1. fuentes directas/autorizadas
2. `cinecalidad`
3. `lamovie`
4. `gnula`
5. providers legacy como fallback

`SiteRating` sigue permitiendo overrides de salud/prioridad desde BD. La policy solo da defaults coherentes.

### AnimeAV1

`AnimeAv1Adapter` añade soporte nativo para:

- `/catalogo`;
- `/media/{slug}`;
- `/media/{slug}/{episode}`;
- metadata MAL expuesta por la fuente;
- variantes `SUB`/`DUB` normalizadas a idiomas;
- mirrors como `SourceLink`;
- locator Zilla conocido convertido a HLS cuando corresponde.

Regla de idioma:

```text
SUB -> audio_language=ja, subtitle_language=es
DUB -> audio_language=es
```

No se implementan bypasses de DRM, CAPTCHA o controles de acceso.

## 5. Ingestión: bootstrap, crawlers y workers

Los crawlers/workers **se quedan**.

### BD vacía: flujo recomendado

```bash
npm install
npx prisma generate
npx prisma db push
npm run bootstrap
npm run ingest:all
npm run dev
```

`npm run bootstrap` crea catálogo canónico TMDB y esqueletos `MediaEpisode` sin inventar streams.

`npm run ingest:all` crea jobs `full_catalog` para todos los targets registrados. El worker los consume al iniciar `npm run dev`.

Modos disponibles:

```bash
npm run ingest:all                 # modo seguro
npm run ingest:all -- --fast       # más concurrencia, delay 0
npm run ingest:all -- --refresh    # reinicia todos los catálogos desde página 1
npm run ingest:all -- --refresh --fast
npm run ingest:all -- --dry        # solo muestra lo que haría
```

`npm run fast-start` se mantiene únicamente como alias de `ingest:all --fast`; el antiguo script duplicado fue eliminado.

Targets actuales de ingestión global:

- AnimeAV1
- AnimeFLV
- JKAnime
- HiAnimes
- GNULA
- Cinecalidad
- LaMovie (películas/series/anime)
- TubePelis (películas/series)
- TioPlus (películas/series)
- Doramasflix (doramas/películas/variedades)
- LatAnime
- TioAnime
- VerAnimes

El modo `full_catalog` sigue páginas hasta agotamiento del catálogo; no depende de `max_pages`. Mantiene checkpoint persistente y un hard cap anti-loop.

Responsabilidad del pipeline:

```text
provider catalog/page
 -> crawler/worker
 -> metadata/identity resolution
 -> MediaItem / MediaEpisode
 -> SourceLink canónico
```

No deben tratar un manifest firmado temporal como identidad persistente. Cuando el directo es efímero se guarda el `canonical_locator` estable y se resuelve Just-In-Time al reproducir.

## 6. SourceLink y lenguaje

Campos relevantes:

```text
source_site
url
canonical_locator
source_kind
language
audio_language
subtitle_language
subtitles
host
source_status
is_verified
resolver_version
```

Normalización recomendada:

- `ja` = japonés
- `en` = inglés
- `es-419` = español latino
- `es-ES` = castellano, cuando se conozca
- `es` = español genérico/indeterminado

Ranking de rendición:

### Anime

```text
JA + SUB ES > audio ES > JA + SUB EN > JA sin subs > otros
```

### Películas/series

```text
EN/ES + SUB ES/EN > EN/ES sin subs > otros
```

La calidad, salud y método de entrega se comparan después de escoger una rendición lingüísticamente adecuada.

## 7. Reproducción

El player no debería depender de embeds como destino final.

Flujo preferido:

```text
SourceLink
 -> canonical locator
 -> POST /api/v1/resolve-embed
 -> ResolutionCoordinator
 -> MP4/HLS/DASH
 -> direct si funciona
 -> proxy session solo si hace falta
 -> failover al siguiente SourceLink
```

Los embeds quedan como compatibilidad/fallback para providers todavía no resolubles de forma nativa; el objetivo es reducirlos gradualmente.

## 8. API

Base principal:

```text
/api/v1
```

El frontend debe consumir la API mediante `src/api/client.ts`; no repartir `fetch()` nuevos por componentes salvo casos muy justificados.

### Catálogo

| Método | Endpoint | Uso |
|---|---|---|
| GET | `/api/v1/shows` | Lista/búsqueda legacy compatible |
| GET | `/api/v1/shows/:id` | Detalle de obra |
| PUT | `/api/v1/shows/:id` | Editar metadata |
| POST | `/api/v1/shows/:id/refresh-streams` | Reingestar/refrescar fuentes |
| GET | `/api/v1/media` | Compatibilidad del catálogo anterior |
| GET | `/api/v1/genres` | Géneros del catálogo |

### Playback

| Método | Endpoint | Uso |
|---|---|---|
| GET | `/api/v1/play/:episodeId` | Cascada DB-only de un episodio |
| GET | `/api/v1/play-multi/:mediaItemId` | Fuentes multi-sitio por MediaItem/temporada |
| POST | `/api/v1/catalog/episode-servers` | Obtener/resolver servidores de una URL de episodio |
| POST | `/api/v1/resolve-embed` | Resolver locator/embed a media reproducible |
| POST | `/api/v1/playback/sessions` | Crear sesión proxy renovable |
| GET | `/api/v1/proxy/stream` | Entrega proxy cuando direct no es viable |

Contrato mínimo recomendado para una resolución:

```json
{
  "url": "https://cdn.example/master.m3u8",
  "original_url": "https://provider.example/watch/123",
  "canonical_locator": "https://provider.example/watch/123",
  "resolved": true,
  "type": "direct",
  "delivery_mode": "direct",
  "provider": "provider-id",
  "is_proxyable": true,
  "is_refreshable": true,
  "requiredHeaders": {},
  "subtitles": []
}
```

Nunca usar una URL firmada temporal como `canonical_locator`.

### Scraping / ingestión

| Método | Endpoint | Uso |
|---|---|---|
| GET | `/api/v1/scraper/presets` | Providers/presets disponibles |
| POST | `/api/v1/catalog/analyze` | Analizar URL con adapter apropiado |
| POST | `/api/v1/catalog/batch-import` | Importar varias URLs |
| POST | `/api/v1/catalog/crawl` | Crear tarea de crawl |
| GET | `/api/v1/tasks/:id` | Estado de tarea |

### Workers

| Método | Endpoint | Uso |
|---|---|---|
| GET | `/api/v1/worker/jobs` | Jobs |
| GET | `/api/v1/worker/settings` | Configuración |
| POST | `/api/v1/worker/settings` | Actualizar configuración |
| POST | `/api/v1/worker/jobs/:id/pause` | Pausar |
| POST | `/api/v1/worker/jobs/:id/resume` | Reanudar |
| POST | `/api/v1/worker/jobs/:id/cancel` | Cancelar |
| DELETE | `/api/v1/worker/jobs/:id` | Eliminar |
| POST | `/api/v1/worker/clear-finished` | Limpiar finalizados |

### Verificación y salud

| Método | Endpoint | Uso |
|---|---|---|
| GET | `/api/v1/verification` | Estado |
| POST | `/api/v1/verification/run` | Ejecutar |
| POST | `/api/v1/verification/config` | Configurar |
| POST | `/api/v1/verification/pause` | Pausar |
| POST | `/api/v1/verification/resume` | Reanudar |
| POST | `/api/v1/verification/stop` | Detener |
| POST | `/api/v1/verification/repair-links` | Reparar locators |
| GET | `/api/v1/sites/ratings` | Ratings de providers |
| POST | `/api/v1/sites/ratings` | Override de rating/estado |
| POST | `/api/v1/network/player-event` | Telemetría del player |

### Usuario

El cliente también consume autenticación, progreso y recomendaciones mediante rutas `/api/...` fuera del namespace v1:

```text
/api/auth/*
/api/progress/*
/api/recommendations
```

Estas rutas deben migrarse a `/api/v1` si se hace una ruptura de API futura; no vale la pena romperlas solo por estética ahora.

## 9. Regla para añadir una API/provider nuevo

Antes de escribir un scraper grande, buscar en este orden:

1. API oficial/documentada.
2. API interna JSON/GraphQL estable del sitio.
3. datos serializados por SSR/Svelte/Next/Nuxt.
4. HTML con Cheerio.
5. JavaScript unpacking específico.
6. browser automation solo como último recurso y fuera del playback normal.

Un provider debe entregar objetos normalizados; no debe meter lógica específica del sitio dentro del player.

Contrato conceptual:

```ts
interface ProviderSource {
  provider: string;
  canonicalLocator: string;
  audioLanguage?: string;
  subtitleLanguages?: string[];
  quality?: string;
  headers?: Record<string, string>;
}
```

## 10. Organización de código

```text
server/
  providers/
    providerPolicy.ts
    ingestionRegistry.ts
  scrapers/
    ScraperManager.ts
    adapters/
  resolvers.ts
  resolutionCoordinator.ts
  playbackSessions.ts
  showService.ts
  metadataEngine.ts

tools/
  bootstrap-catalog.ts
  ingest-all.ts

src/
  api/client.ts
  utils/playerDelivery.ts
```

Principio: **provider-specific code hacia los bordes; core de catálogo/playback genérico en el centro**.

## 11. Qué es legacy y qué no

### Conservar

- workers/crawlers;
- JIT resolution;
- proxy sessions;
- health checks;
- SourceLink multi-fuente;
- TMDB/AniList enrichment;
- adapters con cobertura todavía útil.

### Reducir gradualmente

- duplicación `Show/Episode` vs `MediaItem/MediaEpisode`;
- rankings hardcodeados fuera de `providerPolicy`;
- fallback a iframe/embed;
- documentación histórica duplicada;
- fetches frontend fuera de `src/api/client.ts`.

## 12. Seguridad y repo hygiene

- `.env` nunca se versiona.
- `dist/` nunca se versiona.
- cookies y tokens locales nunca se versionan.
- secretos expuestos en historial deben rotarse, aunque el archivo se elimine después.

## 13. Próximas mejoras

1. Integrar `renditionPreferenceScore()` en el ranking backend de `SourceLink`.
2. Añadir servicio de subtítulos ES/EN por TMDB/IMDb para películas/series.
3. Añadir estado explícito de identity matching: `matched / review / unmatched`.
4. Añadir health tests opt-in por provider y estadísticas de éxito por idioma.
5. Migrar gradualmente toda la UI a `MediaItem/MediaEpisode` y retirar legacy cuando ya no tenga consumidores.
