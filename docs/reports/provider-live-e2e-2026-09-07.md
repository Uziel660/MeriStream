# Verificación E2E de proveedores — 2026-09-07

La prueba de navegador `e2e/provider-boundary-coverage.spec.ts` confirmó el flujo público de GnulaHD: la ficha respondió `200 text/html`, el resolutor interno devolvió un stream HLS directo, el manifiesto maestro y el manifiesto de calidad respondieron `200 application/vnd.apple.mpegurl`, y el primer segmento respondió `206 video/MP2T`.

En la muestra comprobada, Gnula pasó por `bysevepoin.com` y terminó en `edge1-frankfurt-sprintcdn.owphbf24.com`. El host final puede rotar; por eso el código conserva el localizador canónico y vuelve a resolverlo en caliente.

VidSrc también se probó desde el navegador. Su landing respondió `200`, pero el resolutor devolvió explícitamente `resolved: false`, `type: embed` y `failure_reason: unresolved`; esa respuesta no cruza el límite de playback y no se entrega a un `<iframe>` ni al elemento `<video>`.

La ruta de APIs directas se probó con TMDB `27205`. La respuesta fue válida y sus listas `sources`/`fallbackCandidates` respetaron el contrato: si aparecen fuentes, solo pueden ser HLS, DASH o MP4; en esta ejecución no había una API directa configurada y las listas llegaron vacías.

## Reprobe de Cinecalidad/Vimeos (15:58 UTC)

Se repitió la comprobación desde el endpoint JIT y con peticiones HTTP reales al
manifiesto, a su playlist de video y al primer segmento. No se guardan aquí las
URLs firmadas completas.

| Ficha | Host final | Master | Playlist hija | Primer segmento | Audio |
| --- | --- | --- | --- | --- | --- |
| A la carrera | `s9.vimeos.net` | `200 application/vnd.apple.mpegurl` | `200 application/vnd.apple.mpegurl` | `206 video/MP2T` | 2 pistas (`es`, `en`) |
| Dragon Ball Z: La Batalla de los Dioses | `s14.vimeos.net` | `200 application/vnd.apple.mpegurl` | `200 application/vnd.apple.mpegurl` | `206 video/MP2T` | 2 pistas (`es`, `en`) |

Ambas rutas no tuvieron redirecciones. El CDN acepta el `GET` con User-Agent de
Chrome y `Accept-Encoding: identity`; la validación del resolver y la sesión de
proxy usan ese mismo perfil. La matriz E2E del navegador comprobó después la
entrega interna de Cinecalidad, LatAnime y Gnula sin iframes (12/12 casos).
