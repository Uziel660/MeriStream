# 📋 REPORTE E2E TIOPLUS — Auditoría completa 2026-08-22

> Adaptador auditado: `server/scrapers/adapters/TioPlusAdapter.ts`
> Veredicto: **OK — funciona end-to-end sin cambios de código**
> El "FAIL externo: fuentes caídas" del reporte navegador (`REPORTE_E2E_NAVEGADOR_2026-08-22.md`)
> es limitación del sitio origen, no bug del adaptador.

---

## 1. Estado

| Componente | Estado |
|---|---|
| Catálogo (`/peliculas`, `/series`) | ✅ 24 títulos cada uno |
| Ficha película / serie | ✅ metadatos completos (og:, géneros, rating, año) |
| Episodios vía `seasonsJson` | ✅ (8 eps verificados) |
| Streams JIT por episodio | ✅ m3u8 + embed resueltos |
| Tests `tests/scrapers/TioPlusAdapter.test.ts` | ✅ 5/5 passed (9.2s) |
| `npx tsc --noEmit` | ✅ limpio |

**Cambios hechos en el código: NINGUNO.**

## 2. Qué probé (resultados concretos)

Servidor vivo `http://127.0.0.1:3005` (health OK). Todas las pruebas vía
`POST /api/v1/catalog/analyze` + curl directo al origen.

### Catálogo y fichas
- `/peliculas` → 24 items, kind=movie, posters image.tmdb.org.
- `/series` → 24 items, kind=series.
- Película "Los ríos de color púrpura (2000)" → rating 6.92, géneros Crimen/Misterio/Suspense,
  descripción completa.
- Serie "Viaje al centro de la Tierra (2023)" → 8 episodios desde `var seasonsJson`.
- Episodio `/serie/viaje-al-centro-de-la-tierra/season/1/episode/3` → JIT resuelve:
  `https://cdn3.turboviplay.com/data3/6a64de21945e3/6a64de21945e3.m3u8`
  + `https://emturbovid.com/t/6a64de21945e3`

### Cadena HLS de turboviplay (verificada eslabón por eslabón con curl)

```
cdn3.turboviplay.com/data3/{id}/{id}.m3u8        → HTTP 200 application/vnd.apple.mpegurl
  └─ variantes gNNN/gsNNN.turbosplayer.com/file/{uuid}/master.m3u8 → HTTP 200
       └─ segmentos lh3.googleusercontent.com/d/{fileId}=d        → HTTP 200
            (Content-Type image/png PERO Range → 206 Partial Content correcto;
             son los .ts reales disfrazados — reproducibles)
```

- Vía proxy local: master reescrito ✅, variante reescrita ✅ (cada segmento queda
  como ruta relativa `/api/v1/proxy/stream?...`), segmento descargado completo ✅
  (899581 bytes en 0.95s), Range parcial ✅ (206 + Content-Range).

### Servidores alternativos del mismo título

| Host | Resultado | Clasificación |
|---|---|---|
| `hgcloud.to/e/{id}` | Devuelve solo "Page is loading..." con JS ofuscado (string-array rotante); exige ejecución real de JS | **Limitación externa**: irresoluble server-side (curl/cheerio). No bloquea playback porque turboviplay es prioritario |
| `emturbovid.com/t/{id}` | 301 → `turbovidhls.com` (página JWPlayer viva, título tt0228786) | ✅ vivo como fallback embed |
| Players SPA `strp2p.com`, `4meplayer.pro`, `upns.pro` | Siguen correctamente descartados por `UNPLAYABLE_SPA_HOSTS` (WebCrypto contra su API, `restrictEmbed`, anti-headless) | Descartados por diseño |

## 3. Análisis del error reportado por el usuario (CORS)

Diagnóstico recibido: "cdn3.turboviplay.com no incluye Access-Control-Allow-Origin;
el navegador bloquea el .m3u8". **Medido hoy, la hipótesis NO se sostiene:**

1. El CDN SÍ envía CORS abierto en toda la cadena:
   - master turboviplay: `ACAO: *` + `Expose-Headers: Content-Length,Content-Range`
   - variante turbosplayer (HEAD+Range+Origin): `ACAO: *`
   - segmento googleusercontent (HEAD): `ACAO: *` + `Timing-Allow-Origin: *`
2. En la práctica el navegador NUNCA habla directo con el CDN:
   `HLSPlayerModal.tsx:313-323` envuelve toda URL http en `/api/v1/proxy/stream`,
   el proxy añade sus propios headers CORS (`ACAO: *`, métodos GET/HEAD/OPTIONS,
   expone Content-Range) y reescribe playlists enteras a rutas relativas del proxy.
   hls.js consume todo mismo-origen ⇒ cero CORS implicado.
3. `ERR_ABORTED` en un `.ts` con ACAO presente = cancelación benigna de hls.js
   (seek/cambio de calidad/teardown), no bloqueo CORS. Un bloqueo real se muestra
   como error CORS explícito en consola.

Nota: el host `cdn6.ducvomes.com` + referer `animeflv.or.at` del error original
NO pertenece a la cadena de tioplus — es territorio del adaptador AnimeFLV.

## 4. Pendiente fuera de scope (propuesta enviada, esperando aprobación)

> ⚠️ FUERA DE SCOPE: `server/hostProfiles.ts`
> **Riesgo latente medido:** la cadena turboviplay/turbosplayer no tiene perfil propio,
> cae en DEFAULT_PROFILE (passthrough) y recibe Referer ajeno (`animeflv.or.at` desde el
> player, `animeflv.net` default interno). Hoy da igual porque no validan nada (200 con
> cualquier referer/UA), pero si activan hotlink-protection (como ya hizo MP4Upload),
> todos los títulos de tioplus caen a la vez con 403.
> **Cambio propuesto (patrón MP4Upload existente):**
>
> ```ts
> {
>   // TurboViPlay/TurboSPlayer (cadena HLS de tioplus.app, verificado 2026-08-22):
>   // hoy no validan Referer (200 con cualquiera), pero reciben uno ajeno
>   // (animeflv.*) vía passthrough. Perfil preventivo antes de hotlink-protection.
>   match: ["turboviplay.com", "turbosplayer.com"],
>   refererMode: "fixed",
>   referer: "https://tioplus.app/",
> },
> ```
>
> - Sin userAgent/extraHeaders: aceptan cualquier UA moderno (medido); especular sería inventar.
> - `lh3.googleusercontent.com` excluido deliberadamente: host compartido de Google que
>   otros adaptadores pueden usar; ignora Referer; perfil global agrandaría el blast radius.
> - Tras aplicarlo: reiniciar server (tsx sin watch) y repetir curl del proxy + tests 5/5.

## 5. Conclusión

El adaptador tioplus está **sano y verificado E2E**. Su stream principal
(turboviplay m3u8 multi-calidad) está vivo y completamente proxificado.
Los únicos fallos son externos e irrelevante para reproducción: hgcloud.to
(irresoluble server-side) y players SPA (descartados por diseño). Queda una
mejora preventiva propuesta para `hostProfiles.ts` esperando aprobación del usuario.

*Reporte generado por ox-alpha (agente exclusivo del adaptador tioplus) — 2026-08-22.*
