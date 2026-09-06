# MeriStream Provider V2 — ES/EN + Anime JA/ES

## Objetivo

MeriStream deja de tratar cada scraper como dueño del catálogo. El catálogo canónico se identifica con metadata estable (TMDB para películas/series, TMDB + AniList/MAL para anime) y los crawlers/workers pasan a ser **ingestores de fuentes**.

## Qué se conserva

- `MediaItem -> MediaEpisode -> SourceLink` como grafo multi-fuente.
- `ResolutionCoordinator`, `PlaybackSessionStore`, `DeliveryPlanner` y resolución JIT.
- `taskWorker` y workers de verificación/recuperación: sirven para ingestión, refresco y salud de fuentes.
- `EmbedResolvers` como capa de resolución de locators/embeds a media reproducible.
- `SourceLink.canonical_locator`, `language`, `audio_language`, `subtitle_language`, `subtitles`.
- Providers actuales que siguen aportando cobertura, aunque algunos quedan como fallback.

## Qué cambia

### 1. Identidad primero

El crawler nunca debe crear identidad final solo por el título de una web. Flujo recomendado:

1. normalizar título crudo;
2. detectar año, tipo, temporada y episodio;
3. conservar IDs fuertes del proveedor si existen (MAL/AniList/IMDb/TMDB);
4. resolver contra TMDB por aliases + año + tipo;
5. si la confianza es baja, guardar como `unmatched`/pendiente y no contaminar el catálogo canónico.

El `metadataEngine` actual ya cubre título/año/tipo y ranking de candidatos TMDB. Provider V2 añade la regla: **ID externo fuerte > alias/título**.

### 2. Providers como módulos

`server/providers/providerPolicy.ts` centraliza:

- prioridad;
- lifecycle (`active`, `maintained`, `legacy`, `experimental`);
- rol (`primary`, `secondary`, `fallback`, `metadata`);
- idiomas esperados;
- rating por defecto.

Un provider nuevo no debe hardcodearse en múltiples rankings independientes.

### 3. Política de idiomas

#### Anime

1. Japonés + subtítulos español.
2. Audio español (latino/castellano).
3. Japonés + subtítulos inglés.
4. Otros fallbacks.

El doblaje inglés no es prioridad.

#### Películas / series

Inglés y español tienen prioridad similar. Se premian pistas de subtítulos ES/EN independientes del video.

Normalización recomendada:

- `ja`: japonés;
- `en`: inglés;
- `es-419`: español latino;
- `es`: español/castellano genérico;
- `es-ES`: castellano cuando el provider lo distingue.

## Ranking inicial

### Anime

1. AnimeAV1
2. AnimeFLV / JKAnime
3. HiAnimes (cobertura secundaria)
4. LatAnime / TioAnime / VerAnimes como fallback legacy

### Películas y series

1. fuentes directas/autorizadas
2. Cinecalidad
3. LaMovie
4. GNULA
5. otras fuentes legacy como fallback

El ranking final todavía combina salud real, `SiteRating`, tipo de entrega, calidad y disponibilidad.

## AnimeAV1

Se añade `AnimeAv1Adapter` como provider español de primera clase.

Características:

- catálogo `/catalogo`;
- fichas `/media/{slug}`;
- episodios `/media/{slug}/{episode}`;
- metadata MAL cuando la fuente la expone;
- variantes `SUB`/`DUB` normalizadas a metadata de idioma;
- locator conocido de Zilla convertido a su ruta HLS pública cuando aplica.

No se implementan bypasses de CAPTCHA/DRM ni mecanismos para saltar controles de acceso.

## Workers y crawlers

Se conservan.

Su nuevo rol conceptual es:

```text
Provider catalog/page
  -> worker/crawler
  -> IdentityResolver / metadataEngine
  -> MediaItem canónico
  -> MediaEpisode
  -> SourceLink estable/canonical locator
  -> verificación/resolución JIT al reproducir
```

No deben persistir manifests firmados efímeros como fuente canónica.

## Legacy

Un provider marcado `legacy` no se borra automáticamente. Queda fuera del camino preferido y solo debe promoverse de nuevo si las pruebas live demuestran estabilidad.

Esto evita perder cobertura por borrar adaptadores que todavía pueden servir, sin permitir que fuentes frágiles dominen el playback.

## Próximos pasos

1. Mover progresivamente el ranking de idioma al backend para que el frontend no duplique reglas.
2. Añadir servicio de subtítulos externo (OpenSubtitles/SubDL) para películas/series con IDs TMDB/IMDb.
3. Añadir campo de estado de matching (`matched`, `unmatched`, `review`) para ingestión ambigua.
4. Reducir gradualmente la dependencia del modelo legacy `Show/Episode` cuando toda la UI use `MediaItem/MediaEpisode`.
5. Añadir pruebas live opt-in por provider y telemetría de éxito por idioma.
