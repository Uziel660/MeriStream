# 📊 ESTADO DEL PROYECTO NITIFLIX — 2026-08-21

> Documento de estado completo generado por ox-alpha. Complementa a
> `docs/CHECKPOINT_MEGA_2026-08-21.md` (checkpoint de continuidad) y
> `docs/PROJECT_CONTEXT.md` (contexto canónico).

---

## 1. RESUMEN EJECUTIVO

**Nitiflix** es un clon de Netflix personal (Cinema & Anime) con backend scraper
universal (Express en :3000), frontend React (servido desde `dist/`) y 13
adaptadores de scraping registrados en `ScraperManager`.

| Área | Estado |
|---|---|
| Tests unitarios/integración | ✅ 103/103 pasando (16 archivos vitest) |
| TypeScript (`npm run lint` = tsc --noEmit) | ✅ limpio |
| Servidor Express | ✅ corriendo en :3000 (HTTP 200 verificado hoy) |
| Frontend build | ✅ incluye los 3 fixes de la sesión (z-index, all_streams, LaMovie streams) |
| Índice codebase-memory-mcp | ✅ re-indexado hoy (1094 nodos / 3496 aristas) |
| E2E visual por adaptador | ⚠️ solo LaMovie probado parcialmente (salió placeholder VOE) |
| Bug `detected_streams` vacío | 🔴 ABIERTO en 6 adaptadores (ver §4) |

---

## 2. ARQUITECTURA

```
server.ts                     ← Express :3000; claves:
  • POST /api/v1/catalog/analyze   → analyzeUniversalUrl(url) SIN explicitType
  • POST /api/v1/resolve-embed     → EmbedResolvers → playwright sniffer → fallback embed
  • GET  /api/v1/play/:episodeId   → resuelve streams JIT desde DB
server/universalScraper.ts    ← analyzeUniversalUrl(), PRESET_SOURCES
server/scrapers/ScraperManager.ts ← singleton; delega a adapter.analyze(url, explicitType)
server/scrapers/adapters/     ← 13 adaptadores (§3)
server/resolvers.ts           ← EmbedResolvers (VOE, Mp4Upload, YourUpload, Okru…)
server/validator.ts           ← KNOWN_EMBED_HOSTS (embed conocido = éxito válido)
src/components/AdminPanel.tsx ← Panel ingesta (~1800 líneas). Botón play episodio :911-927
src/components/HLSPlayerModal.tsx ← Reproductor activo (z-[9999], failover auto, resolve-embed JIT)
src/App.tsx                   ← onPlayDirect → setPlayingStreamData (:521-527)
src/utils/streamOptimizer.ts  ← rankAndSortServers(): scoring, isEmbedUrl, filtro isRawWebpage
prisma/dev.db                 ← SQLite vía Prisma
informes/*.md                 ← informes por adaptador (Cinecalidad, LatAnime, TioAnime,
                                TioPlus, TubePelis, VerAnimes) + carpeta evidencia/
tests/scrapers/               ← 9 suites de integración contra sitios reales
```

### Flujo de reproducción
```
AdminPanel → POST /catalog/analyze {url} → adapter.analyze()
  → UniversalAnalysisResult {detected_streams[], episodes[]}
Botón ▶️ → all_available_streams = analysisResult.detected_streams || [ep.url]
App.tsx → HLSPlayerModal → rankAndSortServers(candidates):
  • .m3u8/.mp4 directo → HLS.js nativo (proxy/failover si CORS/network error)
  • embed conocido     → POST /api/v1/resolve-embed → m3u8 real o iframe sandbox
  • URL de página web  → ❌ filtrada por isRawWebpage() SOLO para dominios whitelist
```

---

## 3. INVENTARIO DE ADAPTADORES (13)

Todos registrados y visibles en el grafo de código. Tests en `tests/scrapers/`.

| Adaptador | Dominio(s) | Estado código | Test integración | E2E visual |
|---|---|---|---|---|
| LaMovieAdapter | lamovie.org | ✅ parcheado (streams sin explicitType, :479) | ✅ | ⚠️ parcial (placeholder VOE) |
| AnimeFlvAdapter | www3.animeflv.net, jkanime, animeflv.or.at | ✅ parcheado | ✅ 4/4 ×2 | ❌ pendiente |
| CinecalidadAdapter | cinecalidad.am | ✅ auditado | ✅ | ❌ pendiente |
| TubePelisAdapter | tubepelis.com | ✅ parcheado (ep fake películas) | ✅ | ❌ pendiente |
| LatAnimeAdapter | latanime.org | ✅ parcheado (og:title vs botón Reportar) | ✅ | ❌ pendiente |
| TioAnimeAdapter | tioanime.com | ✅ auditado | ✅ | ❌ pendiente |
| TioPlusAdapter | tioplus.app | ✅ auditado | ✅ | ❌ pendiente |
| VerAnimesAdapter | wwv.veranimes.net | ✅ auditado | ✅ | ❌ pendiente |
| ArchiveOrgAdapter | archive.org | ✅ ok | — | ❌ pendiente |
| TvMazeAdapter | tvmaze.com | ✅ solo metadatos | — | N/A |
| DirectStreamAdapter | HLS/MP4 directos | ✅ | — | ❌ pendiente |
| GenericAdapter | fallback | ✅ | — | opcional |

### URLs de prueba clave
- LaMovie: `https://lamovie.org/peliculas/bolt-un-perro-fuera-de-serie-2008/`
- AnimeFLV: `https://www3.animeflv.net/anime/sousou-no-frieren`
- Cinecalidad: buscar en `informes/Cinecalidad.md`
- TubePelis: `https://www.tubepelis.com/pelicula/4603/spider-man-un-nuevo-dia.html`
- LatAnime: `https://latanime.org/anime/mushoku-tensei-jobless-reincarnation-temporada-3`
- Archive.org: `https://archive.org/details/night_of_the_living_dead`
- HLS directo: `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`
- MP4 directo: `https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4`

---

## 4. 🔴 BUGS ABIERTOS

### BUG #1 — `detected_streams` vacío en 6 adaptadores (verificado HOY con search_code)

El patrón roto: `if (explicitType === "stream" || explicitType === "auto") { extraer streams }`.
Como `server.ts` llama `analyze()` **sin** explicitType, el análisis desde la UI
siempre devuelve `detected_streams: []`. El botón ▶️ entonces cae al fallback
`[ep.url]` (URL de página web, no video).

**Fix de referencia (ya aplicado)**: `LaMovieAdapter.ts:479` usa
`if (!explicitType || explicitType === "stream" || explicitType === "auto")`.

**Puntos a parchear (líneas verificadas hoy):**
| Adaptador | Línea | Condición actual |
|---|---|---|
| CinecalidadAdapter.ts | :348 | `explicitType === "stream" \|\| "auto"` |
| LatAnimeAdapter.ts | :246 | ídem |
| TioAnimeAdapter.ts | :574 | ídem |
| TioPlusAdapter.ts | :423 | ídem |
| TubePelisAdapter.ts | :370 | ídem (usa resolveStreamsFromHtml) |
| VerAnimesAdapter.ts | :367 y :416 | dos puntos; :416 solo acepta `"stream"` |

**Mitigación actual**: el filtro `isRawWebpage()` de `streamOptimizer.ts:177-192`
descarta URLs de página SOLO para dominios whitelist (lamovie, animeflv, jkanime,
tioanime, latanime, tubepelis). **FALTA `cinecalidad.am`** → sus páginas web se
cuelan como servidores "directos" falsos → error MEDIA_ERR_SRC_NOT_SUPPORTED (4).

### ISSUE #2 — Placeholder Big Buck Bunny en VOE (investigado, no resuelto)

Al reproducir Bolt/LaMovie el servidor VOE sirvió `Big_Buck_Bunny_1080_10s_5MB.mp4`.
Grep en todo el repo → 0 resultados: NO es nuestro código, es el host VOE que sirve
un demo cuando el archivo real está caído. Opciones: (1) probar los demás servers
del dropdown, (2) heurística anti-placeholder en `EmbedResolvers.resolveWithMeta`,
(3) verificar el embed fuente en lamovie.org.

### ISSUE #3 — E2E visual pendiente para 12+ fuentes

Solo LaMovie fue probado en navegador. Falta validar CONTENIDO REAL visible en
pantalla para todos los demás adaptadores (método completo en CHECKPOINT_MEGA §8).

---

## 5. TRABAJO COMPLETADO

### Sesiones anteriores
1. Auditoría completa de los 12 adaptadores con grafo de código.
2. Parches TDD: AnimeFlv, TubePelis, LatAnime, LaMovie + soporte animeflv.or.at.
3. 9 suites de test de integración en `tests/scrapers/`.
4. Fixes: catalog pagination LaMovie, failover AnimeFLV, CORS whitelist, isMovie.

### Sesión actual (2026-08-21)
1. **Fix LaMovieAdapter.ts:479** — condición `!explicitType || …` → API devuelve
   7 streams reales para Bolt.
2. **Fix App.tsx:525** — `all_streams: streamResult.all_streams ||
   streamResult.all_available_streams` (antes leía una propiedad inexistente).
3. **Fix HLSPlayerModal z-[9999]** — player visible sobre AdminPanel (antes z-50).
4. Validación manual LaMovie/Bolt: análisis UI ✅, failover ✅, video en pantalla ✅
   (pero contenido = placeholder VOE).
5. 103/103 tests + lint limpio + `npx vite build` tras cada fix de src/.
6. Nuevo: adaptadores Cinecalidad, TioAnime, TioPlus, TubePelis, VerAnimes con
   sus informes en `informes/`, tests en `tests/scrapers/` y scripts sueltos
   `test_*.ts` en raíz.
7. Hoy: re-indexado codebase-memory-mcp (1094 nodos) + este documento.

### Sin commitear (working tree)
Modificados: ScraperManager(.test).ts, AnimeFlv/LaMovie/LatAnime adapters,
App.tsx, AdminPanel.tsx, HLSPlayerModal.tsx, .gitignore.
Nuevos sin trackear: 5 adaptadores nuevos, tests/, informes/, docs/, GUIA_NAVEGADOR_MCP.md,
opencode.json/.opencode/, install.ps1, prompts_adaptadores.md, test_*.ts raíz.
Eliminados: bun.lock, nitiflix-v4.0.0.zip.
⚠️ Regla del proyecto: NO commitear sin pedido explícito del usuario.
Limpieza sugerida (algún día): borrar `test_*.ts` de raíz (duplican tests/) y
`server_e2e_pid.txt`.

---

## 6. ENTORNO Y QUIRKS CRÍTICOS

| Tema | Detalle |
|---|---|
| OS | Windows 11. Shell bash (sintaxis Unix OK); PowerShell vía `powershell -NoProfile -Command` |
| Repo | `E:\nitiflix clonado` (ESPACIO en nombre → siempre comillas) |
| Puerto | Express en **3000**; arrancar con `npm run dev` (= tsx server.ts, SIN watch) |
| ⚠️ Frontend | Se sirve desde `dist/` → tras cambiar `src/` correr `npx vite build` SIEMPRE |
| DB | SQLite Prisma `prisma/dev.db` |
| MCP navegador | chrome-devtools o playwright; uids cambian cada snapshot; browser resetea a about:blank entre sesiones |
| curl | OK en bash; en PowerShell usar Invoke-RestMethod |

### Verificación rápida
```bash
npx vitest run        # 103 tests
npm run lint          # tsc --noEmit
npx vite build        # tras cambios en src/
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000   # 200 = vivo
```

---

## 7. HERRAMIENTAS DE NAVEGACIÓN DE CÓDIGO

Índice codebase-memory-mcp activo (proyecto `E-nitiflix-clonado`):
- `search_graph` / `trace_path` / `get_code_snippet` / `query_graph` / `get_architecture`
- Cobertura: 3 archivos parse_partial (AdminPanel.tsx, AllCategoriesModal.tsx,
  UnifiedHeader.tsx — rangos puntuales; preferir grep ahí).
- Excluidos por diseño: node_modules, dist, .git, prisma/dev.db, logs.

⚠️ Preferir estas herramientas antes que grep/bash para explorar código (regla del usuario).

---

## 8. PRÓXIMOS PASOS (orden recomendado)

1. **Parchear BUG #1** (`detected_streams`) en los 6 adaptadores con el patrón de
   LaMovie (:479), añadir `cinecalidad.am` a `isRawWebpage()` de streamOptimizer.ts,
   correr vitest + lint + vite build.
2. **E2E visual** por adaptador (CHECKPOINT_MEGA §8): Archive.org y directos primero
   (sanity), luego scrapers de películas, luego animes, TVMaze ficha, y reintentar
   LaMovie/Bolt con TODOS los servers del dropdown.
3. **Anti-placeholder VOE**: heurística en resolveWithMeta si el issue #2 persiste.
4. Al final: tabla PASS/FAIL completa + actualizar checkpoint + (si el usuario
   pide) commit organizado.

---

*Generado por ox-alpha — 2026-08-21.*
