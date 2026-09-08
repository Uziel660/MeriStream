# Verificación de providers y catálogo — 2026-09-08

Rama local: `integrate/immersive-ui-provider-v2`

## Matriz de resolución

Las pruebas usaron la interfaz HTTP pública de cada sitio, el gateway local y el player interno. En HLS se comprobó el manifiesto y al menos un segmento cuando existía.

| Provider | Resultado | Hosts finales observados | Excepciones |
|---|---:|---|---|
| Cinecalidad | 15/15 directos, 15/15 manifiestos, 15/15 segmentos | `*.vimeos.zip` y `s*.vimeos.net` (Vimeos) | Ninguna en la muestra |
| GnulaHD | 14/15 completos | SprintCDN | One Piece solo expuso embeds públicos Voe/OK/GDTVid/Vidsonic; no se acepta como directo y queda documentado como upstream sin resolución |
| LatAnime | 15/15 directos, 15/15 manifiestos, 14/15 segmentos HLS | SprintCDN; un caso Mega MP4 | El caso Mega se verificó como MP4 relay, no como fallo HLS |
| ZokoAnime | 15/15 directos, manifiestos y segmentos | `hls1/hls2.aniwatchtv.uk` | Solo funciona cuando existe un MAL confiable y el título está en Zoko |
| TioAnime | 13/15 directos, 13/15 manifiestos/segmentos válidos | `*.cloudwindow-route.com` (HLS) | Dos rutas Mega upstream fallaron (502/429); ahora se validan los primeros bytes y se descartan antes de anunciarse |
| VidSrc | 10/10 directos, manifiestos y primer segmento válidos | `yashmak-yonder.site`, `img1.ktocw.com` | El gateway descarta mirrors que entregan imagen/HTML como primer segmento |

Los enlaces de página se resuelven de nuevo bajo demanda; no se persisten URLs CDN firmadas.

## Cambios aplicados

- Identidad TMDB estricta: las filas con `tmdb_id` exacto no se mezclan con títulos legacy. Esto elimina la duplicación de Overflow y el cruce con “Overflow latino”.
- VidSrc valida manifiesto, playlist hija y primer segmento antes de anunciar un mirror.
- Los relays Mega pasan una sonda de metadata y primeros 2 KiB antes de entrar al selector; un 502/429 queda como candidato fallido y no dispara una cascada falsa en el player.
- Gnula usa su endpoint público de player para descubrir servidores en tiempo de reproducción.
- La cartelera pública TMDB pagina las solicitudes y la respuesta unificada de 60 intercala 20 películas, 20 series y 20 animes; las fichas siguen siendo virtuales y se resuelven por sus IDs canónicos.
- La cartelera no importa todo TMDB de forma masiva: Inicio usa un lote acotado y Explorar/Películas/Series/Anime solicitan el siguiente lote bajo demanda. Cada categoría conserva su propio cursor y su propio botón “Cargar más”, sin consumir páginas de las otras ni crear filas duplicadas en la base.
- Si TMDB está temporalmente fuera de servicio, el respaldo local del frontend queda limitado al mismo lote de Inicio (60 fichas); una caché antigua que solo contenga películas se descarta para no ocultar Series o Anime.
- TMDB puede devolver una imagen PNG de logotipo como `poster_path` (el caso observado de “Te irás al infierno” medía 177×21). El catálogo y las recomendaciones ahora consultan el detalle canónico para sustituir ese arte por el póster vertical; el backfill local también marca esos PNG para reparación.
- En la pasada local se repararon 523 de 530 filas con arte PNG TMDB y `poster_path` vacío. Siete títulos no tienen póster vertical en el detalle TMDB y quedan protegidos por el placeholder/arte alternativo, sin fabricar una imagen.
- La búsqueda consulta TMDB y PostgreSQL en paralelo y conserva la ficha local cuando ambas fuentes comparten TMDB, de modo que una coincidencia pública no oculta los providers reproducibles.
- El reparador de identidades usa cruces TMDB→Wikidata y MAL→AniList exactos antes de búsquedas difusas. En los lotes locales de 20 y 50 filas se aplicaron 12 y 19 actualizaciones verificadas; los pendientes y conflictos se conservaron sin conjeturas. La ejecución es seca por defecto y admite aplicación por lotes acotados.
- Subtítulos: OpenSubtitles v3, TVSubtitles, YIFY y SubtitleCat convergen a candidatos internos, deduplicación, ranking, proxy y WebVTT. Las URLs externas no se entregan al frontend.
- Zoko informa `subtitle_mode=burned_in` cuando el endpoint `/sub` no trae pista externa; el player muestra “Subtítulos incrustados”. Los subtítulos quemados en píxeles no se pueden cambiar ni traducir desde el navegador.

## Estado de identidades y catálogo

- Anime en la base local: 6.328.
- Sin MAL: 4.711; sin AniList: 5.005 (después de dos lotes de identidad aplicados).
- Con TMDB pero sin MAL: 3.282; con TMDB pero sin AniList: 3.521.
- Catálogo público TMDB anime: 5.427 resultados totales; las fichas se pueden abrir aunque todavía no exista una fila importada.
- La falta de MAL no se rellena con una conjetura: sin correspondencia confiable Zoko no se anuncia, pero VidSrc y los proveedores de catálogo siguen disponibles.

## Validación ejecutada

- `npm test -- --run --reporter=dot`: 83 archivos, 742 pruebas; 733 pasaron y 9 fallaron por respuestas upstream de Cinecalidad/LaMovie durante esta ejecución (522, búsqueda vacía, poster ausente y streams upstream). Las pruebas unitarias nuevas de búsqueda pasaron 3/3.
- `npx tsc --noEmit --pretty false`: correcto.
- `npm run build`: correcto; Vite y bundle de servidor generados.
- `npm run lint`: correcto (TypeScript).
- Playwright Chromium:
  - exposición LatAnime/Zoko: correcto;
  - fallback TioAnime y reproducción en player interno: correcto;
  - guardia de identidad TMDB para Overflow: correcto.
  - paginación del catálogo unificado y reparación visual de la cartelera: correctas.
  - paginación independiente por categoría desde la vista Explorar: correcta (Series solicita TMDB página 4 sin mover Películas ni Anime).
  - respaldo local ante 502 de TMDB limitado a `limit=60`: correcto.
  - búsqueda de usuario con el typo `one pecie` → tarjeta `One Piece`: correcta.
  - flujo de usuario TMDB “La isla del minotauro” → ficha de 10 episodios → player interno: `Yashmak-yonder (VIDSRC)`, un elemento `<video>`, cero iframes.
  - matriz conjunta de audio, exposición y playback Cinecalidad/LatAnime/Gnula/TioAnime: 6/6 correctas.
- Pruebas reales de red: catálogo, resolución, manifiestos, segmentos y subtítulos internos WebVTT.

## Límites conocidos

- One Piece en Gnula y dos rutas Mega de TioAnime dependen de upstreams que devolvieron error durante la prueba.
  - No todos los títulos tienen MAL/AniList verificable y no se debe inventar un ID para forzar Zoko.
  - Los ocho pendientes del primer lote de reparación requieren una fuente pública que los identifique; permanecen disponibles desde el catálogo TMDB aunque Zoko no se anuncie.
- La disponibilidad y sincronía de subtítulos dependen del release publicado por cada proveedor; SubtitleCat amplía cobertura, pero no garantiza pista española para cada anime.

