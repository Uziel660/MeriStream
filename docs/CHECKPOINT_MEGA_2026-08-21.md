# 🚨 CHECKPOINT MEGA DE CONTEXTO — NITIFLIX (2026-08-21)

> **PROPÓSITO**: Este documento permite a CUALQUIER IA/agente continuar el trabajo
> sin depender del historial de conversación. Léelo COMPLETO antes de tocar nada.
>
> **🔥 TAREA URGENTE PENDIENTE (lo primero que hay que hacer)**:
> **TEST E2E VISUAL PROBANDO CADA ADAPTADOR POR SEPARADO, COMPROBANDO EN PANTALLA
> QUE LO QUE SE REPRODUCE ES LA PELÍCULA/ANIME CORRECTO (NO UN PLACEHOLDER).**
> Detalle completo en la sección 9. El flujo de LaMovie ya funciona pero reprodujo
> "Big Buck Bunny" (placeholder del host VOE) — eso NO cuenta como validación.
> Hay que confirmar visualmente el contenido real para CADA adaptador.

---

## 1. MISIÓN DEL PROYECTO

"Nitiflix" es un clon de Netflix personal (Cinema & Anime) con:
- **Backend scraper universal** que analiza URLs de sitios de streaming/piratas y
  extrae: metadatos (título, año, poster, sinopsis), episodios y servidores de video.
- **Frontend React** con videoteca, panel admin de ingesta, reproductor propio
  (HLS.js + controles custom) con failover automático entre servidores.

El trabajo encargado fue: **auditar, reparar con TDD los 12 adaptadores de scraping,
y validar E2E visualmente en navegador que cada fuente funciona y reproduce el
CONTENIDO REAL**.

---

## 2. ENTORNO Y QUIRKS CRÍTICOS

| Tema | Detalle |
|---|---|
| OS | Windows 11, **PowerShell 5.1** (NO bash). Shell tool = PowerShell |
| Repo | `E:\nitiflix clonado` (con ESPACIO en el nombre — siempre comillas) |
| Git | Es repo git. **NO commitear sin pedido explícito del usuario** |
| Puerto | Servidor Express en **3000** (`server.ts` línea ~22) |
| Arrancar server | `npm run dev` (= `tsx server.ts`). Si `Start-Process npx...` falla, usar `Start-Process -FilePath "cmd.exe" -ArgumentList "/c","npm run dev" -WorkingDirectory "E:\nitiflix clonado" -WindowStyle Hidden` |
| ⚠️ FRONTEND | Se sirve desde **`dist/`** (`server.ts:690-693`, express.static). **TRAS CUALQUIER CAMBIO EN `src/` HAY QUE CORRER `npx vite build`** (~5-12s) o el cambio no se ve |
| curl | `curl` en PowerShell = alias roto de Invoke-WebRequest. Usar `Invoke-RestMethod -Uri ... -Method POST -ContentType "application/json" -Body $body` |
| Glob/Grep tools | `glob` falla a veces ("ripgrep execution failed"). Alternativa: `Get-ChildItem -Recurse -Filter`. Grep tool SÍ funciona normalmente |
| chrome-devtools MCP | Funciona pero en una sesión las invocaciones se emitieron mal (salían como bash). Si pasa: esperar/reintentar más tarde, avisar al usuario. Las herramientas son `chrome-devtools_snapshot/click/fill/wait_for/take_screenshot/evaluate_script/navigate_page/list_console_messages/list_network_requests` |
| Chrome profile | El MCP usa su propio perfil; cerrar Chrome manual si molesta |
| DB | SQLite vía Prisma en `prisma/dev.db` |

### Comandos verificación
```powershell
npx vitest run        # tests (103 pasando actualmente)
npm run lint          # tsc --noEmit
npx vite build        # REQUERIDO tras cambios en src/
# API test:
$body = '{"url":"https://..."}'; Invoke-RestMethod -Uri "http://localhost:3000/api/v1/catalog/analyze" -Method POST -ContentType "application/json" -Body $body
```

---

## 3. ARQUITECTURA (mapa de archivos)

```
server.ts                     ← Express: rutas API + static dist/. Claves:
  • :434  POST /api/v1/catalog/analyze   → analyzeUniversalUrl(url) SIN explicitType
  • :257  POST /api/v1/resolve-embed     → EmbedResolvers → playwright sniffer → fallback embed
  • :205  GET  /api/v1/play/:episodeId   → resuelve streams JIT desde DB
  • :634       /api/v1/extract           → extractStreamFromUrl
  • :306       /api/v1/media/:id/stream
server/universalScraper.ts    ← analyzeUniversalUrl(), PRESET_SOURCES (:4-53, URLs ejemplo por fuente)
server/scrapers/ScraperManager.ts ← singleton; analyze(:98) delega a adapter.analyze(url, explicitType)
server/scrapers/adapters/     ← 12 adaptadores (ver sección 4)
server/types.ts               ← ExtractedEpisode {number,title,url}, UniversalAnalysisResult
                                 (⚠️ detected_streams va en el RESULTADO, no por episodio)
server/resolvers.ts           ← EmbedResolvers: resolveWithMeta, resolveVoe/Mp4Upload/YourUpload/Okru/Streamtape...
server/validator.ts           ← KNOWN_EMBED_HOSTS (embeds = éxito válido)
src/components/AdminPanel.tsx ← Panel ingesta (1803 líneas). Botón play episodio: :911-926
src/components/HLSPlayerModal.tsx ← REPRODUCTOR ACTIVO (1332 líneas). z-index :715.
                                  Recibe all_streams(:163), rankAndSortServers, failover auto,
                                  resolveEmbed on-demand para embeds (:431-465)
src/components/PlyrPlayerModal.tsx ← player alternativo PLYR (z-9999) — NO está importado en App.tsx
src/App.tsx                   ← HLSPlayerModal :475; onPlayDirect→setPlayingStreamData :521-527
src/utils/streamOptimizer.ts  ← rankAndSortServers() ordena por calidad/salud
src/api/client.ts             ← api.resolveEmbed :312
docs/PROJECT_CONTEXT.md       ← contexto canónico del proyecto (19KB, léelo también)
informes/*.md                 ← informes por adaptador: Cinecalidad, LatAnime, TioAnime, TioPlus, TubePelis, VerAnimes
```

### Flujo completo de reproducción (Importador Rápido)
```
AdminPanel → POST /api/v1/catalog/analyze {url} → adapter.analyze()
  → UniversalAnalysisResult {detected_streams[], episodes[]}
AdminPanel botón ▶️ → onPlayHandler({title, stream_url: ep.url,
  all_available_streams: analysisResult.detected_streams || [ep.url]})   (:915-920)
App.tsx onPlayDirect → setPlayingStreamData({streamUrl, all_streams})    (:521-527)
HLSPlayerModal → rankAndSortServers(candidates) → intenta índice 0:
  • .m3u8 → HLS.js; si NETWORK_ERROR → reintenta vía /api/v1/proxy/stream;
    si vuelve a fallar → siguiente servidor (failover automático)
  • embed (filemoon/voe/mega...) → llama POST /api/v1/resolve-embed:
      - si resuelve .m3u8/.mp4 real → reproduce nativo
      - si no → iframe sandbox con la URL del embed
```

---

## 4. INVENTARIO DE ADAPTADORES (12) Y ESTADO

Todos registrados en `ScraperManager`. Tests en `tests/scrapers/`.

| Adaptador | Archivo | Estado código | Test unitario | E2E VISUAL contenido real |
|---|---|---|---|---|
| LaMovieAdapter | adapters/LaMovieAdapter.ts | ✅ parcheado hoy | ✅ | ⚠️ Parcial: reproduce pero salió placeholder VOE (ver §7) |
| AnimeFlvAdapter (www3.animeflv.net + jkanime) | adapters/AnimeFlvAdapter.ts | ✅ parcheado (extractWordPressServers, metadata WP theme) | ✅ 4/4 | ❌ pendiente |
| animeflv.or.at (mismo adapter, dominio nuevo) | idem | ✅ soporte añadido | ✅ | ❌ pendiente |
| CinecalidadAdapter | adapters/CinecalidadAdapter.ts | ✅ auditado | ✅ | ❌ pendiente |
| TubePelisAdapter | adapters/TubePelisAdapter.ts | ✅ parcheado (fallback ep fake para películas :363-366) | ✅ 4/4 | ❌ pendiente |
| LatAnimeAdapter | adapters/LatAnimeAdapter.ts | ✅ parcheado (título og:title vs "Reportar episodio" :296-303) | ✅ | ❌ pendiente |
| TioAnimeAdapter | adapters/TioAnimeAdapter.ts | ✅ auditado | ✅ | ❌ pendiente |
| TioPlusAdapter | adapters/TioPlusAdapter.ts | ✅ auditado | ✅ | ❌ pendiente |
| VerAnimesAdapter | adapters/VerAnimesAdapter.ts | ✅ auditado | ✅ | ❌ pendiente |
| ArchiveOrgAdapter | adapters/ArchiveOrgAdapter.ts | ✅ ok | — | ❌ pendiente |
| TvMazeAdapter | adapters/TvMazeAdapter.ts | ✅ solo metadatos (sin video) | — | N/A (verificar ficha) |
| DirectStreamAdapter | adapters/DirectStreamAdapter.ts | ✅ HLS/MP4 directos | — | ❌ pendiente |
| GenericAdapter | adapters/GenericAdapter.ts | ✅ fallback | — | opcional |

**URLs de prueba** (presets en `universalScraper.ts:4-53` + usadas en esta sesión):
- LaMovie: `https://lamovie.org/peliculas/bolt-un-perro-fuera-de-serie-2008/`
- AnimeFLV: `https://www3.animeflv.net/anime/sousou-no-frieren`
- animeflv.or.at: usar un anime del catálogo del sitio (ej. buscar uno popular)
- Cuevana preset: `https://cuevana.biz/pelicula/oppenheimer`
- TVMaze: `https://www.tvmaze.com/shows/169/breaking-bad`
- Archive.org: `https://archive.org/details/night_of_the_living_dead`
- HLS directo: `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`
- MP4 directo: `https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4`
- Para Cinecalidad/TubePelis/LatAnime/TioAnime/TioPlus/VerAnimes: mirar `informes/<Adaptador>.md` — ahí están las URLs exactas usadas en sus validaciones originales.

---

## 5. TRABAJO COMPLETADO (historial)

### Sesión anterior
1. Auditoría completa de los 12 adaptadores con grafo de código (943 nodos).
2. Parches TDD: AnimeFlvAdapter, TubePelisAdapter, LatAnimeAdapter, LaMovieAdapter.
3. Soporte nuevo dominio animeflv.or.at (catálogo/detalle/stream).
4. 9 archivos de test nuevos en `tests/scrapers/`.
5. Guía `GUIA_NAVEGADOR_MCP.md` para validación visual.

### Sesión actual (2026-08-21) — 3 bugs encontrados y corregidos
1. **`LaMovieAdapter.ts:479`** — `analyze()` solo extraía streams si
   `explicitType === "stream"|"auto"`, pero `server.ts:441` llama sin explicitType
   → `detected_streams` vacío. **FIX**: condición ahora `!explicitType || ...`.
   Verificado por API: devuelve **7 streams** (m3u8 goodstream + filemoon +
   vimeos + goodstream embed + hlswish + voe + mega.nz).
2. **`App.tsx:525`** — `onPlayDirect` leía `streamResult.all_streams` pero
   AdminPanel envía `all_available_streams` → player recibía SOLO la URL de la
   página (no un video) → error CORS. **FIX**: 
   `all_streams: streamResult.all_streams || streamResult.all_available_streams`.
3. **`HLSPlayerModal.tsx:715`** — player con `z-50`, mismo que AdminPanel
   (que se monta después en DOM) → player INVISIBLE detrás del panel.
   **FIX**: `z-[9999]`.

Tras cada fix de frontend: `npx vite build`. Server reiniciado (`npm run dev`).

### Validación ya hecha (LaMovie/Bolt)
- Análisis UI: título/año 2008/rating 6.5/poster/sinopsis ✅
- Player visible sobre panel ✅ · dropdown "Servidor 2/7" con health indicators ✅
- Failover automático Servidor 1 (HLS, CORS esperado) → Servidor 2 ✅
- Video reproduciéndose en pantalla (timeline avanzando) ✅
- **PERO**: el contenido era Big Buck Bunny → NO cuenta como validación final (§7).

### Tests
`npx vitest run` → **103/103 en 16 archivos ✅**. Limpieza: borrados
`_e2e_browser.ts`, `_test_stream.ts`, `_e2e_*.png`.

---

## 6. SUBAGENTES (regla del proyecto)

`.opencode/instructions/invocacion-paralela.md`: SIEMPRE lanzar los 3 juntos en
UN mensaje (paralelo): `hy3-analista` (plan), `mimo-coder` (código),
`spark-revisor` (QA). Cada task autosuficiente (los subagentes no ven el historial).
⚠️ spark-revisor falló repetidamente en sesión anterior ("Task cancelled").
Si delegas, cumple la regla de los tres. El trabajo con navegador MCP lo hace
el agente principal (los subagentes no comparten esa sesión).

---

## 7. 🐛 ISSUE ABIERTO #1 — PLACEHOLDER BIG BUCK BUNNY (URGENTE investigar/mitigar)

**Síntoma**: Al reproducir Bolt, el servidor activo "[Direct HD] VOE HighSpeed"
reprodujo `Big_Buck_Bunny_1080_10s_5MB.mp4` (host: test-videos.co.uk).

**Investigado**: `grep buckbunny|test-videos|bunny *.ts` en TODO el repo → **0 resultados**.
**Conclusión**: el placeholder NO está en nuestro código. Viene del PROPIO host VOE:
`voe.sx/e/qxjjxiz2dzhe` sirve ese video demo cuando el archivo real está caído,
bloqueado por región o eliminado. Nuestro `/api/v1/resolve-embed` (server.ts:257)
hizo su trabajo: sniffeó lo que la página realmente servía.

**Qué hacer (opciones, por prioridad)**:
1. **Probar otros servidores**: en el dropdown quedan filemoon, hlswish, mega.nz,
   goodstream, vimeos — reproducir cada uno hasta encontrar el contenido REAL de
   la película. Es lo primero: quizá VOE simplemente tiene muerto ese archivo.
2. **Heurística anti-placeholder**: detectar URLs conocidas de placeholders
   (test-videos.co.uk, "BigBuckBunny", duración ≈10s) en
   `EmbedResolvers.resolveWithMeta`/playwright sniffer y marcar el servidor como
   `failed` para que el failover salte al siguiente automáticamente.
3. Verificar contra la página fuente (lamovie.org) que el embed VOE sea el correcto.

---

## 8. 🚨 ISSUE URGENTE #2 — TEST E2E POR ADAPTADOR CON CONTENIDO REAL

> Esto es LO SIGUIENTE a hacer. Nada está "terminado" hasta completar esta tabla.

**Método obligatorio** (navegador chrome-devtools MCP — NO scripts):
1. Ir a `http://localhost:3000` (recargar con Ctrl+Shift+R mental: el MCP navega fresh).
2. Click "Panel Admin" → pestaña "Extractor Universal & Ficha".
3. Rellenar textbox URL → click "Analizar" → esperar resultado (hasta 40s).
4. **VERIFICAR EN CAPTURA/SNAPSHOT**: título correcto, año, poster visible, episodios.
5. Click "Reproducir este stream" → el player abre (ya visible, z-9999).
6. **CONFIRMAR EN CAPTURA QUE EL VIDEO MOSTRADO ES LA PELÍCULA/ANIME CORRECTO**:
   - El frame visible debe corresponder al contenido (p. ej. Night of the Living
     Dead es B/N clásico; Tears of Steel es sci-fi; Frieren anime; etc.).
   - Probar el dropdown de servidores si el primero da placeholder/error.
   - Un iframe de filemoon/mega mostrando el player interno del host con el
     título correcto TAMBIÉN cuenta como éxito (regla de oro: embed = válido).
   - Placeholder genérico (Big Buck Bunny, "video no disponible", pantalla gris)
     = FALLO → anotar y pasar al siguiente servidor.
7. Capturar screenshot como evidencia. Registrar PASS/FAIL por adaptador.
8. Opcional: verificar extracción de catálogo (URLs raíz tipo /peliculas, /anime)
   y que aparezcan tarjetas en "Obras Adicionales Detectadas".

**Orden sugerido** (empezar por los que probablemente funcionan mejor):
1. Archive.org (MP4 público, debería ser trivial) — Night of the Living Dead
2. Direct MP4 (TearsOfSteel.mp4) y Direct HLS (mux.dev) — sanity check del player
3. Cinecalidad (película, ver informes/Cinecalidad.md para URL exacta)
4. TubePelis (ídem informes/TubePelis.md)
5. AnimeFLV www3 (Frieren) + animeflv.or.at
6. LatAnime, TioAnime, TioPlus, VerAnimes (episodios anime, ver informes/)
7. TVMaze (solo ficha metadatos, sin reproducción)
8. Reintentar LaMovie/Bolt probando TODOS los servidores del dropdown hasta
   hallar contenido real (o concluir que lamovie tiene todos caídos hoy).

**Criterios de fallo aceptables a documentar (no arreglar hoy)**: hosts caídos,
geo-bloqueos, Cloudflare. Lo que SÍ hay que arreglar: bugs de NUESTRO código
(adaptador no encuentra streams, player rompe, failover no salta, etc.).

---

## 9. GUÍA RÁPIDA CHROME-DEVTOOLS MCP

- `navigate_page {type:"url", url:"http://localhost:3000"}` — navegar
- `take_snapshot` — árbol a11y con uids (CAMBIAN en cada snapshot, no reusar viejos)
- `click {uid}` / `fill {uid, value}` / `wait_for {text:[...] , timeout}`
- `take_screenshot` — evidencia visual (usar visión para confirmar contenido)
- `evaluate_script {function}` — JS libre (scroll, fetch API, inspección DOM)
- `list_console_messages {types:["error","warn"]}` / `list_network_requests`
- El panel admin abre modal con pestañas: "Extractor Universal & Ficha" es la
  primera. Textbox grande + botón "Analizar" (deshabilitado hasta escribir).
- El player: botón "Servidor N/M" arriba a la derecha abre dropdown de servidores.
- Cerrar player: botón X o Escape.

---

## 10. REGLAS DE ORO (no negociables)

1. **Embed válido = éxito**: filemoon/voe/mega/yourupload/streamwish sirviendo su
   reproductor con la película correcta CUENTA como reproducción exitosa aunque
   el .m3u8 crudo dé 403.
2. **Contenido real obligatorio**: validar que SE VE la película/anime correcto,
   no placeholders. Big Buck Bunny / pantallas de error = FAIL.
3. Tras cambiar `src/` → `npx vite build` SIEMPRE.
4. Tras cambiar adapters → correr `npx vitest run` y `npm run lint`.
5. No commitear sin pedirlo el usuario.
6. CORS en fetch directo de m3u8 es ESPERADO → el player ya hace proxy/failover.
   No "arreglar" eso.
7. PowerShell ≠ bash: sin `&&` (usar `;` o `if ($?)`), curl→Invoke-RestMethod.

---

## 11. ESTADO DE SERVIDOR/PROCESOS AL CIERRE DE ESTA SESIÓN

- Server: corriendo en :3000 vía `cmd.exe /c npm run dev` (ventana oculta).
  Si está caído: relanzar con el comando de §2.
- Último build de frontend: incluye los 3 fixes (bundle index-*.js actual).
- Tests: 103/103 ✅ · tsc limpio ✅
- Índice de grafo de código: **indexar el repo con codebase-memory-mcp**
  (`index_repository repo_path="E:\nitiflix clonado"` mode full) — pedida por el
  usuario para que otra IA pueda navegar el código con search_graph/trace_path.
  Verificar con `index_status` después.

---

## 12. CHECKLIST DE CONTINUACIÓN (copiar y tachar)

```
[ ] Indexar repo en codebase-memory-mcp + index_status OK
[ ] Investigación placeholder VOE (§7): probar resto de servidores de Bolt
[ ] E2E Archive.org — Night of the Living Dead visible en pantalla
[ ] E2E Direct MP4 TearsOfSteel visible
[ ] E2E Direct HLS mux.dev visible
[ ] E2E Cinecalidad — película correcta visible
[ ] E2E TubePelis — película correcta visible
[ ] E2E AnimeFLV www3 — Frieren ep correcto visible
[ ] E2E animeflv.or.at — episodio correcto visible
[ ] E2E LatAnime — episodio correcto visible
[ ] E2E TioAnime — episodio correcto visible
[ ] E2E TioPlus — episodio correcto visible
[ ] E2E VerAnimes — episodio correcto visible
[ ] TVMaze — ficha metadatos correcta (sin video)
[ ] Catálogo: tarjetas extraídas visibles en UI (al menos 1 fuente)
[ ] Informe final PASS/FAIL por adaptador + capturas
[ ] Arreglar SOLO bugs de nuestro código que surjan
[ ] vitest + lint verde al final
```

*Generado por ox-alpha — checkpoint de continuidad total.*
