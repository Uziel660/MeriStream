# Resumen de cambios — Rediseño nitiflix (2026-08-23/24)

## Lo que se cambió

### F1 · Ingesta español-first (TMDB es-MX)
- `server/metadataEngine.ts`: nueva `parseTitleQuery()` limpia títulos sucios ("Kaguya-sama TP2 en español latino" → título base + season + year). Fix crítico: faltaba `import "dotenv/config"` → TMDB_API_KEY nunca cargaba.
- `fetchTMDBMetadata` ahora guarda `tmdb_id`, `poster_path`, `backdrop_path` crudos; géneros REALES vía `/genre/*/list?language=es-MX` (caché 24h); `english_title` por segunda búsqueda en-US.
- **Validación cruzada anti-falsos matches**: `isSuspiciousAnimeMatch()` detecta matches TMDB sin género Animación o pre-1995 → AniList/Kitsu ganan si matchean mejor (caso real: "Dandelion" animeflv ya no cae en TV movie británica de 1994).
- Schema: columnas nuevas nullable en Show/MediaItem (`tmdb_id`, `original_title`, `poster_path`, `backdrop_path`, `base_normalized_title`). Modelo nuevo `SiteRating`.
- `showService.ts`: guardado scraper-first (enriquecimiento solo llena huecos), skip de re-enriquecimiento si el adapter ya trajo tmdb_id/poster_path.

### F2 · Agrupación de temporadas
- `normalizeBaseTitle()` en db.ts; matching por `base_normalized_title` → "TP1"/"TP2" confluyen en un solo MediaItem/show.
- Backfill ejecutado: 13 duplicados legacy fusionados.
- `MediaDetailsModal`: dropdown de temporadas.

### F3 · Jerarquía de servidores + ratings de sitios
- `server/utils/streamSorter.ts`: TIER 1 (ugc-cdn-caching/goodstream/acek-cdn/uqload/vimeos.net), TIER 2 (doodstream+genéricos AnimeFLV), TIER 3 (vidhide), TIER 4 (mega/mp4upload). Lista negra voe/mixdrop/mxdrop/filemoon filtrada antes de ordenar.
- Resolvers nuevos: doodstream/uqload/vidhide (`server/resolvers/*`) — pendiente prueba empírica con stream_tester.
- `SiteRating` seed (tioplus 9, tioanime 10, lamovie/cinecalidad/latanime 8, animeflv 5, tubepelis 0 off) + CRUD en AdminPanel (pestaña "Fuentes").

### F4 · Multi-fuente + cascada inter-sitios
- `syncEpisodeSources` aglutina N SourceLink por episodio, idempotente.
- Endpoint `GET /api/v1/play-multi/:media_item_id`: agrupa por sitio → ordena por SiteRating DESC + tier ASC.
- `HLSPlayerModal`: consume `ranked_streams`; auto-fallback recorre la cascada completa; selector manual OCULTO por defecto, aparece solo al agotar toda la cascada; toggle en Configuración (localStorage `voidstream_show_server_selector`).

### F5 · Imágenes adaptativas
- `src/utils/imageSizes.ts`: hero = backdrop original, bento = w1280, cards = w342, thumbs = w780.
- Modal detalle sin backdrop: blur-fill + object-contain (ya no se recorta).

### Worker crawler paralelo
- Pool de workers (default 3, max 6), claim atómico, token-bucket por dominio, recovery de jobs huérfanos, dedupe indexado, skip doble-enriquecimiento.

## Estado actual / problema abierto

**La reproducción HLS está rota**: manifestLoadError masivo en sprintcdn/playmudos/goodstream/acek-cdn/dramiyos. Diagnóstico parcial hecho:

- `attachSource` sí enruta por proxy cuando corresponde.
- `PROXY_FIRST_HOSTS` (streamOptimizer.ts) NO incluye sprintcdn/owphbf24/dramiyos.
- `HOST_PROFILES` no tiene perfiles para owphbf24.com ni dramiyos-cdn.com ni variantes acek-cdn.
- curl confirma: playmudos da 403 directo Y vía proxy.
- Sospecha de bug en `buildProxyHeaders` (hostProfiles.ts): un test devolvió `"Range": "Goodstream"` — sin confirmar si es artefacto del script de prueba o bug real.

## Próximos pasos (lo que iba a hacer)

1. Leer firma real de `buildProxyHeaders` en hostProfiles.ts y descartar el bug del header Range fantasma.
2. Añadir a `PROXY_FIRST_HOSTS`: sprintcdn, owphbf24, dramiyos-cdn (+ variantes acek).
3. Bisección con curl para crear HOST_PROFILES de esos CDNs (qué headers exigen: Referer/UA/Sec-Fetch).
4. Investigar por qué el toggle del selector manual no muestra el selector aunque esté activado (sospecha: se lee solo al montar el modal).
5. Reiniciar servidor tras fixes y pedir reprobar Dandelion/MarriageToxin.
6. Pendiente aparte: metadatos que siguen en inglés/japonés (左ききのエレン, Re:Zero) y probar resolvers dood/uqload/vidhide en stream_tester.
