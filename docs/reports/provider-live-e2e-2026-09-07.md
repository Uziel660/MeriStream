# Verificación E2E de proveedores — 2026-09-07

La prueba de navegador `e2e/provider-boundary-coverage.spec.ts` confirmó el flujo público de GnulaHD: la ficha respondió `200 text/html`, el resolutor interno devolvió un stream HLS directo, el manifiesto maestro y el manifiesto de calidad respondieron `200 application/vnd.apple.mpegurl`, y el primer segmento respondió `206 video/MP2T`.

En la muestra comprobada, Gnula pasó por `bysevepoin.com` y terminó en `edge1-frankfurt-sprintcdn.owphbf24.com`. El host final puede rotar; por eso el código conserva el localizador canónico y vuelve a resolverlo en caliente.

VidSrc también se probó desde el navegador. Su landing respondió `200`, pero el resolutor devolvió explícitamente `resolved: false`, `type: embed` y `failure_reason: unresolved`; esa respuesta no cruza el límite de playback y no se entrega a un `<iframe>` ni al elemento `<video>`.

La ruta de APIs directas se probó con TMDB `27205`. La respuesta fue válida y sus listas `sources`/`fallbackCandidates` respetaron el contrato: si aparecen fuentes, solo pueden ser HLS, DASH o MP4; en esta ejecución no había una API directa configurada y las listas llegaron vacías.
