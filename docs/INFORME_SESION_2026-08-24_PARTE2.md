# INFORME DE SESIÓN — 2026-08-24 (parte 2)

Continuación de `RESUMEN_CAMBIOS_2026-08-24.md`. Todos los cambios verificados con `tsc --noEmit`, suites vitest y pruebas E2E en vivo. Servidor reiniciado y operativo en el puerto de `app.config.ts`.

---

## 1. Causa raíz del fallo masivo de reproducción (resuelta)

- **Síntoma**: ningún servidor reproducía en el navegador (manifestLoadError, pantallas negras, failover en cascada), pero curl contra el backend funcionaba.
- **Causa**: `proxiedUrl.ts` y `streamOptimizer.ts` caían al fallback hardcodeado `http://127.0.0.1:3005` (puerto muerto) mientras el backend escucha en 3000. hls.js pedía el manifest a un puerto sin servidor.
- **Fix**: fuente única de verdad **`app.config.ts`** (`APP_CONFIG.{host,port}`) consumida por `server.ts` (listen + CORS), `proxiedUrl.ts` (re-exporta `backendOrigin()`) y `streamOptimizer.ts`. Cambiar el puerto ahí + reiniciar = se propaga a todo. Se eliminó `PORT` de `.env`/`.env.example`.

## 2. CORS / túnel

- `https://classifieds-discounts-father-barrier.trycloudflare.com` añadido a `localAllowedOrigins()` en `app.config.ts`. Verificado por header `Access-Control-Allow-Origin` en respuesta real.

## 3. Vimeos (403 / miniatura que se quita) — resuelto

Diagnóstico en vivo (~90 sondas con URLs frescas):
- El CDN **prohíbe HEAD** (403 con body de 146 bytes que envenenaba la rama MP4 del proxy → "El origen ignoró Range").
- **Rechaza Origin/Referer** (estorbaban) y exige `User-Agent` Chrome/124 completo + `Accept-Encoding: identity`.
- El MP4 de `download_orig` está muerto para playback; el `master.m3u8` del player del embed funciona pero **~75-85% de los tokens `?t=` nacen muertos**.

Fixes (`server/hostProfiles.ts`, `server/scrapers/vimeosResolver.ts`, `server/resolvers.ts`):
- Perfil vimeos: `refererMode:"none"`, UA Chrome/124, `Accept-Encoding: identity`, undici, match `vimeos.` (cubre TLDs rotativos .net/.zip).
- Resolver **validate-and-retry**: unpack del player → candidatos (.m3u8 primero) → cada URL se valida con GET real (m3u8→200, mp4→206) → reintenta hasta 8 embeds frescos. Nunca entrega tokens muertos.
- Evidencia E2E: master→playlist hija (581 segmentos)→segmentos 200.

## 4. Playmudos (403) — diagnosticado

- El perfil era correcto: los URLs del 403 llegaron **sin token** (`?st=&e=`) desde caché expirada. Con token fresco: 200/206 (verificado master→segmento). El re-resolve JIT existente cubre el caso. Perfil re-verificado, sin cambios.

## 5. Deduplicación y títulos basura — resuelto (21 tests)

- Nuevo `server/utils/titleNormalizer.ts`: `parseRawTitle()` (canonical/year/language/quality) y `normalizeTitleKey()` (clave canónica de fusión).
  - Cortes estructurales ("Capitulo/Temporada/Online/Ver…" descarta el resto), precedencia de idioma (sub>latino>castellano), años sueltos de cola, colapso "Full HD", slugs con underscores, fallback anti-vacío.
- `server/showService.ts`:
  - Todo título entrante se limpia ANTES de guardar y de calcular claves → `"Toy Story 5 Latino Español HD"` ≡ `"Toy Story 5"` (clave `toystory5`).
  - El título visible guardado es el canonical; `mergeShowEpisodes` **asciende títulos legacy sucios** cuando llega el limpio de la misma obra.
  - `enrichUniversalMetadata(canonicalTitle)` (antes iba el crudo → TMDB no matcheaba → sin descripción).
  - El año desambigua remakes (misma clave + años plausibles distintos = obras separadas); años desconocidos/legacy no rompen la fusión.

## 6. Metadatos en español — resuelto (30 tests)

`server/metadataEngine.ts`:
- **Géneros**: mapa ES para leftovers de TMDB (`Action & Adventure`→`Acción y Aventura`), AniList/MAL y TVMaze; el genre map de TMDB se traduce al cachearse.
- **Overview siempre en español**: fallback es-MX→en-US con traducción; rescate de candidatos con overview vacío (Cinecalidad: TMDB tiene muchas fichas es-MX sin sinopsis); `fillWeakDescription()` rellena descripciones débiles desde AniList/TVMaze/Wikipedia conservando identidad TMDB.
- **Búsqueda con título limpio**: `buildSearchCandidates()` usa `parseRawTitle` primero, parser legacy de respaldo, con reintentos.
- **Traductor resiliente**: reintento tras 429 de Google + respaldo MyMemory + decode de entidades.
- Ejemplos reales: *Dandelion* pasó de géneros en inglés+sinopsis inglesa (429 silencioso) a `[Acción, Comedia, Sobrenatural]`+sinopsis ES; *Wistoria* a `[Animación, Acción y Aventura, Ciencia Ficción y Fantasía]`.

## 7. Scraper: barrido completo, rápido y paralelo

- **full_catalog autónomo** (`taskWorker.ts`): sin cap de 50 páginas (fusible anti-bucle en 10000), auto-descubre página a página hasta agotar catálogo (página vacía / 2 páginas sin obras nuevas / 5 errores seguidos), crash-safe con reanudación sin repetir páginas (marcador `__nitiflix_discovery_complete__`), reclamo atómico de jobs.
- **Pipeline paralelo productor-consumidor**: el descubridor de páginas y los guardadores de obras corren SIMULTÁNEOS; la página 1 se importa mientras se trae la 2. Los savers ociosos esperan (poll 400ms) hasta que llega más cola.
- **Patrones de paginación por sitio** (`buildPageUrl`, 9/9 verificados): animeflv.net `?page=`, mirrors animeflv `/anime/page/N/`, tioplus `/peliculas/N`, lamovie `?page=`, latanime `?p=`, tioanime `?p=`, veranimes `?pag=`, cinecalidad `/page/N/`, genérico `?page=` con auto-corte.
- **Máximo paralelismo**: `page_concurrency=8`, `item_concurrency=8` (techo clamp 16), delay default 800ms.
- **Pausa fantasma arreglada**: al detener, el job quedaba en `"pending"` y el poller de 1s lo re-arrancaba solo. Ahora queda `"paused"` (el poller lo ignora); reanudar pone `"pending"` explícito.
- **Borrado de jobs arreglado**: borrar un job corriendo ahora señaliza `"cancelled"` y espera gracia (≤3s) a que los workers corten antes de eliminar la fila (antes seguía fetch+import varios segundos y "parecía que no se borró").

## 8. UI (AdminPanel + reproductor)

- Crawler: full_catalog ya no muestra ni envía límite de páginas (era `max_pages: 20` fijo); tarjeta informativa de barrido autónomo.
- Slider de delay: 0-5000ms (default 300; 0 = velocidad máxima) con hint.
- Botón "Rastrear Catálogo" del Extractor Universal: ya NO dispara un job default de animeflv (bug de estado React stale: `setState` + llamada síncrona leía el valor viejo). Ahora lleva a **Ingesta de Lotes → Modo 2** con la URL precargada para elegir páginas o catálogo completo.
- Reproductor: la tuerquita de configuración incluye ahora **"Cambiar servidor"** (abre el panel de servidores desde el menú de calidad).

## 9. Verificación

- `tsc --noEmit`: OK en cada cambio.
- vitest: titleNormalizer 21✅, metadataEngine 30✅, suite server 82✅, resolvers/streamSorter/VideoExtraction 24✅.
- E2E en vivo: proxy master→hija→segmento 200 (owphbf24, goodstream, playmudos, vimeos); CORS del túnel; barrido animeflv reanudado solo tras reinicio (pág. 33+, 791 obras); salud del server 200.

## 10. Pendientes (siguientes rondas)

1. **Reconciliación de duplicados YA existentes** en DB (p. ej. anime duplicado en captura) — el dedup nuevo solo aplica a imports nuevos; hace falta script de merge one-off.
2. **Cap de géneros** (películas con ~20 géneros) + vocabulario cerrado alineado a la lista de categorías de la UI.
3. **Importar primero / enriquecer después**: ingesta veloz con nombre provisional + autorregulación en background (TMDB ~40-50 req/s sin límite diario).
4. **Traductor local / APIs alternativas** (IMDb no tiene API pública gratuita oficial; evaluar OMDb/TVMaze/AniList/caché local de traducciones).
5. Migración Prisma opcional: columnas `page_concurrency`/`item_concurrency` en WorkerSettingsStore (hoy viven en memoria) y `raw_title` para conservar el título original del scraper.
