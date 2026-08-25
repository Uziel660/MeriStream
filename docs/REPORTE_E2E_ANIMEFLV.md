# 📊 Reporte E2E — Adaptador AnimeFLV (`AnimeFlvAdapter.ts`) — 2026-08-23

> Auditoría + fix + validación end-to-end del adaptador `animeflv`
> (archivos: `server/scrapers/adapters/AnimeFlvAdapter.ts`, dominios
> `www3.animeflv.net` / `www4.animeflv.net` / `jkanime.net`).
> Contexto: bug ALTO detectado en `docs/REPORTE_E2E_NAVEGADOR_2026-08-22.md` (Caso 9).

---

## 1. Estado final: ✅ FIXEADO Y VALIDADO E2E

| Antes | Ahora |
|---|---|
| Página `/ver/{slug}-{n}` se colaba como "stream" → player muere con `MEDIA_ERR_SRC_NOT_SUPPORTED` (código 4) | Resolución JIT vía `POST /api/v1/catalog/episode-servers` → 10 servidores reales; reproducción sostenida en navegador |

## 2. Causa raíz (dos capas)

1. **Capa endpoint (ya fixeada el 2026-08-22):** `www3.animeflv.net` redirige a `www4` y sirve
   `var videos = []` para muchas IPs (servidores retenidos server-side, verificado por curl:
   HTTP 200 → redirect → HTML con `var videos = []`). El adaptador lista episodios pero no
   había vía para resolver servidores al momento del play. Fix: nuevo endpoint
   `episode-servers` en `server.ts` que llama `extractStreamFromUrl()` → espejo jkanime.
2. **Capa adaptador (fixeada en esta auditoría):** el espejo jkanime funcionaba, pero:
   - **StreamTape usa extensión falsa**: su embed `/e/{id}/x.mp4` es una página HTML, no un
     archivo. `resolveCandidates()` lo clasificaba como stream DIRECTO por la extensión y lo
     promovía a `stream_url` principal. Hoy además está caído (404 "File not found" verificado).
     Resultado: mismo síntoma del Caso 9 filtrando por otra vía.
   - **Plantilla JS no reproducible**: el regex de iframes capturaba
     `https://jkanime.net/jkplayer/c1?u=` (concatenación `'...c1?u='+val.remote` en el HTML de
     jkanime), un artefacto con parámetro vacío que se colaba en la lista de servidores.

## 3. Cambios hechos

### `server/scrapers/adapters/AnimeFlvAdapter.ts`
1. `resolveCandidates()`: el chequeo de **host embed conocido ahora va ANTES** de
   `EmbedResolvers.isDirectMediaUrl()`. Los embeds conocidos (streamtape incluido) pasan tal
   cual como embeds aunque su path termine en `.mp4`; solo los hosts desconocidos se evalúan
   como medios directos. Comentario inline documenta por qué (regla anti-extensión-falsa).
2. `parseJkanimeServers()`: se excluyen URLs que terminan en `?...u=` (plantilla
   `jkplayer/c1?u=`) tanto en el regex de iframes JS como en el de wrappers jkplayer.

### Tests
- **Nuevo:** `tests/scrapers/AnimeFlvJkParse.test.ts` — fixture OFFLINE (HTML real de
  `https://jkanime.net/sousou-no-frieren/1/` capturado el 2026-08-22): valida los 9+ servidores
  decodificados, ausencia del artefacto `c1?u=`, y clasificación correcta del embed streamtape.
- Regresión: `tests/scrapers/AnimeFlvAdapter.test.ts` (4/4), `tests/scrapers/AnimeFlvOrAt.test.ts`
  (4/4), `server/scrapers/VideoExtraction.test.ts` (3/3).

### Docs
- `docs/ESTADO_PROYECTO_2026-08-22.md`: sección "Auditoría adaptador animeflv" añadida.

## 4. Validación ejecutada

### 4.1 Calidad estática y unitaria
| Check | Resultado |
|---|---|
| `npx tsc --noEmit` | ✅ limpio |
| Fixture offline (JkParse) | ✅ 3/3 |
| Integración AnimeFlv (red real) | ✅ 4/4 — `stream_url` = m3u8 playmudos, GET 200 |
| Integración animeflv.or.at | ✅ 4/4 |
| VideoExtraction compartido | ✅ 3/3 |
| `npx vite build` | ✅ OK (sin cambios en `src/`, verificación de no-regresión) |

### 4.2 API contra servidor vivo (post-reinicio)
| Endpoint / URL | Resultado |
|---|---|
| `GET /api/v1/health` | ✅ ok |
| `analyze` `/browse` | ✅ page_type=catalog, **24 cards** |
| `analyze` `/anime/sousou-no-frieren` | ✅ detail, **28 episodios**, metadatos AniList |
| `episode-servers` `/ver/sousou-no-frieren-1` | ✅ resolved=true, **10 streams limpios**, `stream_url`=playmudos HLS, sin residuo `c1?u=`, streamtape degradado a fallback |
| `episode-servers` `/ver/sousou-no-frieren-12` | ✅ generaliza (otro episodio) |
| `episode-servers` jkanime nativo `/sousou-no-frieren/1/` | ✅ resolved=true (misma limpieza) |
| curl m3u8 firmado | ✅ HTTP 200 `application/vnd.apple.mpegurl` |

Respuesta real de `episode-servers` (ep1):
```
stream_url = https://nika.playmudos.com/TWRsQUdL....m3u8?st=...&e=1787463438
all_available_streams (10): playmudos HLS · mp4upload .mp4 directo · Mega embed ·
sfastwish (StreamWish) · voe.sx · vidhidevip · mp4upload embed · streamtape · d-s.io · mdy48tn97
```

### 4.3 E2E en navegador (Playwright MCP, snapshot + DOM puntual)
Pasos reales ejecutados sobre `http://127.0.0.1:3005`:

1. Panel Admin → preset "AnimeFLV" → autocompleta `/browse` → Analizar →
   ficha de catálogo con **24 obras adicionales detectadas**. ✅
2. Textarea → `https://www3.animeflv.net/ver/sousou-no-frieren-1` → Analizar →
   ficha "Sousou no Frieren" ★9.1 + "Episodios y Fuentes de Video (1)". ✅
3. Botón **"Reproducir este stream"** (el caso que antes daba código 4):
   - Player abrió con selector de **10 servidores**.
   - Reproducción sostenida verificada por DOM en 4 muestras:
     `currentTime` 0 → 91.4s → 122.1s → **177.9s**, `paused=false`,
     `readyState=4`, `videoWidth=1280`, duración 25:59, buffer creciente
     (bufferedEnd 151→178s), `video.error=null` siempre. ✅
   - Stream inicial: MP4 directo de mp4upload vía proxy. Al agotarse su token
     el **failover automático** entró solo (comportamiento esperado del player).
4. Failover manual: selector de servidores muestra estados ("Servidor Verificado
   (Online)" para Mega/Servidor4/etc.; mp4upload marcado "No disponible" tras su
   416). Click en Servidor 4 → iframe StreamWish (`sfastwish.com/e/ppgosg56iyip`)
   montado sin errores de consola. ✅

## 5. Errores de consola observados (ninguno atribuible al adaptador)

| Error | Clasificación |
|---|---|
| `mp4upload.com:183/...video.mp4` CORS directo + proxy Range→**416** | Bug MEDIO ya documentado: MP4 directo no debería ir por `/api/v1/proxy/stream` (afecta Archive.org también). **Fuera de scope** (`server.ts` proxy + `HLSPlayerModal.tsx`) |
| Imagen anilist.co bloqueada por CORS | Cosmético, externo |
| favicon.ico 404 | Trivial, externo |

## 6. Limitaciones externas (NO bugs del adaptador)

1. **StreamTape caído** al momento de la prueba: embed responde 404 "File not
   found". Sigue en la lista como fallback; si el sitio lo restaura, vuelve a funcionar.
2. **d-s.io (Doodstream)** sin respuesta server-side (timeout/conexión).
3. Tokens efímeros: el `.mp4` de mp4upload y los `st=/e=` de playmudos caducan;
   el diseño JIT (resolver al dar play) cubre esto por diseño.
4. `var videos = []` en www3/www4: retención server-side permanente hasta hoy;
   el espejo jkanime es la vía viva y estable (9-10 servidores por episodio).

## 7. Hosts del episodio, ordenados por estabilidad observada

| Host | Estado 2026-08-22/23 | Rol |
|---|---|---|
| playmudos HLS (`nika.playmudos.com`) | ✅ estable 5/5 pruebas, token ~12h, 200 sin Referer | **Primario** (gana scoring HLS+calidad sin tocar nada) |
| MP4Upload | ⚠️ vivo pero `.mp4` directo falla por proxy 416 (bug MEDIO); su embed sí funciona | Fallback |
| Mega / VOE / StreamWish(sfastwish) / Vidhide / Mixdrop(mdy48tn97) | ✅ embeds vivos | Failover |
| StreamTape | ❌ 404 caído | Limitación externa |
| d-s.io (Doodstream) | ❌ sin respuesta | Limitación externa |

## 8. Pendientes fuera de scope (requieren aprobación previa)

1. **MP4 directo sin proxy** (bug MEDIO global): streams `.mp4` públicos deberían
   cargarse directos sin `/api/v1/proxy/stream` Range/206. Tocaría
   `src/components/HLSPlayerModal.tsx` + `server.ts`. Ya estaba en §6 del ESTADO.
2. Opcional: elevar aún más el peso de playmudos/HLS en `src/utils/streamOptimizer.ts`
   (hoy ya gana naturalmente; solo si se quiere forzar prioridad absoluta).

---

*Reporte generado por ox-alpha — sesión de auditoría exclusiva del adaptador animeflv, 2026-08-22/23.*
