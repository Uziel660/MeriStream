# Doramasflix adapter: validación en vivo

Fecha: 2026-09-08  
Rama: `integrate/immersive-ui-provider-v2`

La ficha pública `https://doramasflix.io/doramas/khom-khlang` se analizó junto con su primer capítulo.

- La ficha expone JSON-LD con el título mostrado `Khom Khlang` y el alias nativo `ข่มขลัง`.
- El cruce del alias nativo devolvió TMDB `308261`; el endpoint público de IDs externos de TMDB devolvió IMDb `tt45115286`.
- El HTML/React Flight conserva la temporada y la secuencia de episodios publicados. Los anchors HTML se usan como complemento.
- La consulta GraphQL pública `https://user-api.fluxcedene.net/graphql` devolvió los enlaces del capítulo.
- En la muestra observada los enlaces rotaron entre `primeload.co`, `do7go.com`, `flaswish.com`, `voe.sx` y `streamtape.com`.
- `flaswish.com` resolvió a `premilkyway.com/hls2/.../master.m3u8`; el manifiesto y un segmento respondieron correctamente y el vídeo avanzó en Chromium.
- Primeload devolvió un manifiesto `primecdn.co` sin token que respondió 403 fuera de su reproductor. Se descarta como fuente directa; no se reproduce ni se intenta sortear su atestación.
- En una ficha con identidad disponible (“Love With Benefits”, TMDB `224505`), `VidSrcClient` devolvió fuentes HLS; su disponibilidad se valida por manifiesto y segmento antes de anunciarlas.

El contrato del adaptador solo considera éxito una URL HLS/DASH/MP4 directa y alcanzable. Las URLs de página, embeds y servidores que requieren interacción protegida se devuelven como no resueltas para que el gateway continúe con otro candidato o con VidSrc.
