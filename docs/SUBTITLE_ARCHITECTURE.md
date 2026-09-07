# SubtitleGateway

`SubtitleGateway` centraliza la búsqueda y entrega de subtítulos para el
reproductor interno. La aplicación recibe únicamente rutas propias de
`/api/v1/subtitles/file/:token.vtt`; nunca recibe la URL del proveedor.

## Flujo

```text
TMDB + temporada/episodio
        |
        v
TMDB -> IMDb (cache 24 h)
        |
        v
OpenSubtitles v3 + TVSubtitles + YIFY (paralelo)
        |
        v
normalizar idioma/formato -> deduplicar -> rankear
        |
        v
registrar token interno
        |
        v
descargar con allowlist + redirect limitado
        |
        v
ZIP/GZIP/SRT/ASS/VTT -> UTF-8 WebVTT
        |
        v
HLSPlayerModal
```

La búsqueda tiene cache TTL, timeout por provider y health state con cooldown
tras fallos consecutivos. Un provider con cooldown se omite temporalmente y el
resto puede entregar resultados en el mismo request.

## Providers activos

| Provider | Tipos | Entrada comprobada | Salida al cliente |
| --- | --- | --- | --- |
| `opensubtitles-v3` | movie, series, anime | `opensubtitles-v3.strem.io/subtitles/{movie\|series}/...json`; descarga `subs5.strem.io` | token interno WebVTT |
| `tvsubtitles` | series | búsqueda pública `tvsubtitles.net/search1.php`, ficha de temporada y ZIP | token interno WebVTT |
| `yify` | movie | ficha por IMDb en `yifysubtitles.ch/movie-imdb/...`; ZIP con Referer de la ficha | token interno WebVTT |

Las pruebas reales confirmaron respuestas HTTP, descarga y conversión para
Matrix (película) y Game of Thrones S01E01 (serie), incluyendo ES/EN cuando el
provider tenía esa pista disponible. La allowlist de `SubtitleProxy` limita
cada provider a sus hosts conocidos y rechaza HTTP, hosts desconocidos y
redirecciones fuera de la allowlist.

Los sidecars que ya entrega el resolver de ZokoAnime pasan por la misma capa:
el CDN `aniwatchtv.uk` se valida con allowlist y el endpoint JIT devuelve un
token MeriStream. Esto conserva las pistas de Zoko sin abrir una URL externa en
el reproductor.

## Contrato

Los providers producen `SubtitleCandidate[]`. El gateway devuelve:

```ts
{
  subtitles: SubtitleTrack[],
  tracks: SubtitleTrack[], // alias de compatibilidad
  providers: { queried: string[], failed: { provider: string, reason: string }[] },
  elapsedMs: number,
  cached: boolean,
}
```

Cada `SubtitleTrack.url` tiene la forma
`/api/v1/subtitles/file/<token>.vtt`. El endpoint de archivo siempre responde
`text/vtt; charset=utf-8` y no reenvía la URL externa al navegador.

## Endpoints

- `GET /api/v1/subtitles/movie/:tmdbId`
- `GET /api/v1/subtitles/series/:tmdbId?season=1&episode=1`
- `GET /api/v1/subtitles/anime/:tmdbId?season=1&episode=1`
- `GET /api/v1/subtitles?tmdb_id=...&kind=...` (compatibilidad)
- `GET /api/v1/subtitles/file/:token.vtt`
- `GET /api/v1/subtitles/health`

## Configuración

Los valores opcionales están en `.env.example`:

- `OPENSUBTITLES_V3_ENDPOINTS`
- `OPENSUBTITLES_V3_TIMEOUT_MS`
- `TVSUBTITLES_TIMEOUT_MS`
- `YIFY_SUBTITLES_BASE_URL`
- `YIFY_SUBTITLES_TIMEOUT_MS`
- `SUBTITLE_PROVIDER_TIMEOUT_MS`
- `SUBTITLE_SEARCH_CACHE_TTL_MS`
- `SUBTITLE_PROXY_TIMEOUT_MS`
- `SUBTITLE_PROXY_MAX_BYTES`
- `SUBTITLE_PROXY_CACHE_TTL_MS`

No se necesita API key para los tres providers activos. `TMDB_API_KEY` sí se
usa para resolver el IMDb canónico cuando la petición no lo incluye.

## Referencias de implementación

- [SubSense](https://github.com/NepiRaw/Stremio-SubSense): agregación paralela,
  cache, health y providers sin key.
- [SmallThingz/subdl](https://github.com/SmallThingz/subdl): patrones de
  scraping y normalización de providers públicos.
- [Bazarr](https://github.com/morpheus65535/bazarr): matching de release e
  idiomas.
- [OpenSubtitles v3](https://opensubtitles-v3.strem.io/manifest.json): contrato
  público usado por el adapter principal.
- [Harbor OpenSubtitles provider](https://github.com/harborstremio/harbor/blob/master/src/lib/subtitles/providers/opensubtitles-v3.ts): endpoints de respaldo y forma de respuesta.
