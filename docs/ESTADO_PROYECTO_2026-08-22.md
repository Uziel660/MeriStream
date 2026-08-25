# 📊 ESTADO DEL PROYECTO NITIFLIX — 2026-08-22 (CANÓNICO)

> **Para la IA que continúa:** este es el ÚNICO documento de estado vigente.
> Léelo completo antes de actuar. Complementos: `README.md` (arquitectura),
> `informes/*.md` (detalles por adaptador), `docs/GUIA_E2E_NAVEGADOR_ADAPTADORES.md`
> (cómo probar el player en navegador). Los docs `*_2026-08-21.md` son historial.

---

## 1. QUÉ ES

Clon de Netflix personal (Cine & Anime). Backend Express+TS (:3005) con 12
adaptadores de scraping modulares (Strategy pattern), frontend React servido
por el mismo server, SQLite vía Prisma. El video se extrae Just-In-Time al
dar play y se sirve por un proxy anti-CORS con perfiles de headers por host.

## 2. ESTADO ACTUAL: ✅ E2E NAVEGADOR COMPLETADO (10/10 CASOS)

Git: `main` con commits `9f8a54b` y `340cce2` pusheados; pendientes de commit:
guía E2E, REPORTE E2E navegador y ESTADO actualizado.

**E2E navegador ejecutado (ver `docs/REPORTE_E2E_NAVEGADOR_2026-08-22.md`):**
PASS mux.dev, LaMovie, Cinecalidad, TubePelis, LatAnime, VerAnimes*
(failover embed StreamWish). FAIL externos: MP4 directo por proxy Range/206
(0b, Archive.org), fuentes caídas del origen (TioPlus), servidores eliminados
por copyright (TioAnime). Único bug accionable detectado: AnimeFLV.

### Fixes aplicados el 2026-08-22 tras el E2E (PENDIENTES de validar E2E)

1. **AnimeFLV JIT (bug ALTO del reporte)** — nuevo endpoint
   `POST /api/v1/catalog/episode-servers` en `server.ts` que llama
   `extractStreamFromUrl()` (espejo jkanime verificado: 9 servidores vivos);
   `api.getEpisodeServers()` en cliente; `App.tsx onPlayDirect` ahora detecta
   páginas crudas (`isEmbedUrl`/extensiones) y resuelve antes de abrir player.
2. **Zilla Networks WAF** — Cloudflare bloquea `/segs/*` con 403 salvo que se
   envíe `Sec-Fetch-Site: same-origin` (verificado por bisección curl).
   Nuevo perfil en `server/hostProfiles.ts` (client undici).
3. **Presets de catálogo para AdminPanel** — `PRESET_SOURCES` ampliado a 12
   presets con URLs DE CATÁLOGO verificadas en vivo contra analyze():
   animeflv `/browse` (24 cards), lamovie API `wp-api/v1/listing/movies?page=1`
   (1000 items), cinecalidad home (12), tubepelis `/peliculas.html`,
   tioplus `/peliculas`, latanime `/animes`, tioanime `/directorio`,
   veranimes `/animes`, TVMaze, archive.org, HLS directo, MP4 directo.
   Grid AdminPanel ajustado a 4 columnas mostrando dominio real.
   NOTA LaMovie: el sitio es SPA client-side; su catálogo público clásico
   `/peliculas?page=N` hoy da 404 — la vía viva es su API JSON listing.

### Fixes previos ya verificados E2E

1. `VerAnimesAdapter.ts` — analyze() sin explicitType devuelve streams.
2. `TioAnimeAdapter.ts` — cfglobalcdn/vidcache al final; Mega/YourUpload/ok.ru primero.
3. `server/hostProfiles.ts` — HOST_PROFILES declarativa (Goodstream, MP4Upload,
   Zilla). **Nuevo WAF = 1 entrada aquí, NUNCA condicionales inline en server.ts.**
4. `HLSPlayerModal.tsx` — referer elegido por host.
5. `src/vite-env.d.ts` creado; ref muerto eliminado.

### Auditoría adaptador animeflv (2026-08-22, sesión paralela)

Fixes en `AnimeFlvAdapter.ts` validados con fixture offline + integración (14 tests OK):
1. `resolveCandidates`: el chequeo de host conocido ahora va ANTES de
   `isDirectMediaUrl`. Motivo: streamtape usa extensión falsa `/e/{id}/x.mp4`
   (es HTML); clasificado como directo se colaba como stream principal → código 4.
   Hoy streamtape está caído (404 "File not found" verificado por curl).
2. `parseJkanimeServers`: se excluye la plantilla `jkplayer/c1?u=` (parámetro
   vacío del JS de jkanime, no reproducible). Nuevo test offline:
   `tests/scrapers/AnimeFlvJkParse.test.ts`.
Servidor estable del episodio: playmudos HLS (`nika.playmudos.com`, m3u8
firmado ~12h, 200 sin Referer). Validación E2E navegador completa
(reproducción sostenida 178s, failover funcional): ver
`docs/REPORTE_E2E_ANIMEFLV.md`.

### Calidad (tras fixes de hoy)

tsc limpio · vite build OK · tests streamOptimizer 23/23 · suite completa 103
sin tocar aún (validar con `npx vitest run`). Pendiente reiniciar server para
probar episode-servers + perfil Zilla contra servidor vivo.

---

## 3. ARQUITECTURA EN 60 SEGUNDOS

```
UI AdminPanel → POST /api/v1/catalog/analyze {url}
  → ScraperManager.canHandle() → adapter.analyze()
  → {title, episodes[], detected_streams[]}
Botón ▶️ → HLSPlayerModal → rankAndSortServers() (streamOptimizer.ts)
  → .m3u8/.mp4 → HLS.js nativo VÍA PROXY /api/v1/proxy/stream
     (proxy consulta hostProfiles.buildProxyHeaders() para UA/Referer/cliente)
  → embed conocido → /api/v1/resolve-embed o iframe sandbox
Failover automático entre servers si uno falla.
```

Archivos clave: `server.ts` (proxy+API), `server/scrapers/adapters/*` (12),
`server/resolvers.ts`, `server/hostProfiles.ts`, `src/components/HLSPlayerModal.tsx`,
`src/utils/streamOptimizer.ts`, `src/App.tsx`.

## 4. ENTORNO Y QUIRKS (CRÍTICO)

| Tema | Regla |
|---|---|
| URL del server | SIEMPRE `http://127.0.0.1:3005`. Puerto 3000 = Gotenberg/Docker, ignorar |
| Servidor | `npm run dev` (= tsx SIN watch). Tras cambiar `server/**` hay que REINICIARLO (pedir permiso al usuario antes de matar procesos) |
| Frontend | tras cambiar `src/` correr `npx vite build` (en prod sirve `dist/`) |
| Verificación rápida | `npx vitest run` (103), `npm run lint`, curl health `/api/v1/health` |
| Windows | shell bash sintaxis Unix; paths con espacio SIEMPRE entre comillas |
| Navegador MCP | límite ~32MB: PROHIBIDO screenshots full-page/video/dumps base64; solo snapshot de accesibilidad |
| Notificaciones | email al usuario vía `node ~/.claude/send-email.js "<asunto>" "<msg>"`; beep `powershell -c "[console]::beep(1000,800)"` |
| Git | NO commitear/pushear sin pedirlo el usuario explícitamente |

## 5. LIMITACIONES EXTERNAS CONOCIDAS (NO arreglar, son del sitio fuente)

1. cfglobalcdn.com: cert Cloudflare Origin CA no confiable + token secip de otra IP.
2. vidcache.net: StretchFS exige handshake propietario.
3. VOE sirve placeholder Big Buck Bunny cuando el archivo cayó (ya invalidado en scoring).
4. Tokens HLS caducan (Goodstream 12h, Byse ~15min): el diseño JIT lo cubre.

## 6. TRABAJO PENDIENTE (orden recomendado)

1. **Validar fixes de hoy contra servidor vivo** ← SIGUIENTE PASO (requiere
   reiniciar server): (a) reproducir ep1 de Frieren desde catálogo AnimeFLV
   vía nuevo endpoint episode-servers; (b) reproducir un stream Zilla
   (perfil Sec-Fetch-Site); (c) presets de catálogo desde AdminPanel.
2. MP4 directo sin proxy (bug MEDIO del reporte): streams `.mp4` públicos
   sin hotlink-protection deberían cargarse directo, sin `/api/v1/proxy/stream`
   Range/206 (afecta Archive.org y sanity MP4).
3. Doodstream resolver dedicado (`pass_md5`) en `EmbedResolvers` (opcional).
4. UX embed StreamWish: aviso al usuario sobre popunders/doble click del host.
5. Mantener: re-indexar codebase-memory tras cambios grandes de código;
   correr `npx vitest run` completo antes de commitear.

## 7. REGLAS DE ORO PARA LA IA QUE CONTINÚA

- Subagentes SECUENCIALES uno a uno (esperar fin antes de lanzar otro).
- Antes de diagnosticar un 403/500: revisar headers con curl directo al host
  (UA atado a token, Referer exigido/prohibido, Sec-Fetch) → luego perfil en hostProfiles.
- Todo fix se valida: tsc + vitest relevantes + (si toca src/) vite build +
  prueba E2E ligera contra servidor vivo + re-index.
- Actualiza ESTE documento al cerrar cada sesión de trabajo significativa.

*Documento generado por ox-alpha — 2026-08-22.*
