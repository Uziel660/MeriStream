# INFORME DE SESIÓN — 2026-08-24 (PARTE 3)

Continuación de `INFORME_SESION_2026-08-24_PARTE2.md`. Cubre todo lo implementado desde entonces: workers paralelos, verificación automática, editor de catálogo, reconciliación de secuelas, índice de re-escaneo, write-buffer, admin `/admin` con login y centralización de configuración. Todo verificado con `tsc --noEmit`, pruebas en vivo y servidor reiniciado.

---

## 1. Configuración centralizada: `app.config.ts`

- **Única fuente de verdad** de host/puerto del backend (`APP_CONFIG`), consumida por `server.ts` (listen + CORS), `src/utils/proxiedUrl.ts` y `src/utils/streamOptimizer.ts`.
- Orígenes CORS permitidos en `localAllowedOrigins()` (incluye túneles cloudflared activos). Alternativa por entorno: `ALLOWED_ORIGINS` (CSV).
- `PORT` eliminado de `.env` (era un segundo valor que generó el bug masivo de reproducción).

## 2. Reproducción: causa raíz + selector premium

- **Causa del fallo masivo en navegador**: el frontend apuntaba al puerto muerto 3005 mientras el backend vive en el puerto de `app.config.ts`. Resuelto por la centralización.
- **Selector de servidores SIEMPRE visible** con >1 opción (antes dependía de `serverSelectorVisible`; un embed muerto —ej. Mega— nunca activaba error y el usuario quedaba atrapado).
- **Premium por plataforma**: el backend adjunta `source_site` en todas las rutas de reproducción (`/play`, `episode-servers`, `play-multi`). El panel muestra primero el MEJOR servidor de cada plataforma (badge = plataforma, no servidor); sin datos reales no se fuerza nada (va a "Otros servidores").
- **"Cambiar servidor" también en la tuerquita** de configuración.
- **VOE / Mixdrop / filemoon DESCARTADOS** por completo: lista negra en backend (`streamSorter`) + espejo client-side (`streamOptimizer`) para colar también `all_available_streams` crudos y re-resolves JIT.

## 3. Workers: paralelismo real + estabilidad

- **Multi-job**: hasta `max_concurrent_jobs` (3 por defecto, configurable en UI) barridos SIMULTÁNEOS; el resto queda en cola pendiente SIN LÍMITE. Botón **"Iniciar ahora"** (`POST /api/v1/worker/jobs/:id/start`) para arrancar cualquier pendiente saltándose la cola.
- **Pipeline productor-consumidor** dentro de cada job: el descubridor de páginas y los guardadores de obras corren simultáneos (la página 1 se importa mientras se trae la 2).
- **Carreras corregidas**: (a) el poller re-entrante podía superar el límite con BD lenta → mutex `isClaiming`; (b) la recuperación de huérfanos del boot reseteaba jobs ya reclamados por este proceso → guard `activeJobIds` + re-chequeo de estado; el poller espera a que la recuperación termine.
- **Pausa fija**: al detener, el job queda `"paused"` (antes `"pending"` y el poller de 1s lo re-arrancaba solo). Reanudar pone `"pending"` explícito.
- **Borrado de jobs activos**: señaliza `"cancelled"` y espera ≤3s a que los workers corten antes de eliminar la fila.
- **Exprimir**: `page_concurrency=8`, `item_concurrency=8` (techo 24), delay por defecto 800ms; BUG corregido: el slider en 0 caía a `0 || 1500 = 1500` (ahora `?? 500`, 0 = válido). Jitter proporcional al delay.
- **Ajustes en vivo** (`GET/POST /api/v1/worker/settings`): jobs simultáneos (con recomendación), delay, jitter, concurrencias, jobs activos y reporte anti-bot.

## 4. Detección anti-bot (Cloudflare etc.)

- `server/utils/antiBot.ts`: `detectAntiBot(status, headers, bodySample)` — señales `cf-mitigated`, `server: cloudflare`, "Just a moment", `challenge-platform`, 429 repetidos.
- Instrumentado en `BaseAdapter.fetchHtml` (todos los adapters) y en los fallos de página/item del worker.
- **Auto-throttle por dominio**: ≥3 hits en 10 min → el delay efectivo de ESE host se duplica (máx ×4), expira a los 10 min. Nunca toca settings globales.
- **Banner rojo en la UI** (Ajustes del Worker) cuando hay bloqueos activos.

## 5. Paginación y scrapers

- **Tabla de patrones por sitio** en `buildPageUrl` (9/9 verificados): animeflv `?page=`, mirrors `/anime/page/N/`, tioplus `/peliculas/N`, lamovie `?page=`, latanime `?p=`, tioanime `?p=`, veranimes `?pag=`, cinecalidad `/page/N/`.
- **TioAnime fix**: el adapter hardcodeaba `/directorio` e ignoraba la página → ahora pagina real (p1≠p2 verificado en vivo).
- **LaMovie completo**: presets de SERIES (`postType=tvshows`, 1,089) y ANIMES (`postType=animes`, 970) además de películas; items pre-enriquecidos (año/rating/póster del API); fichas `/peliculas|/series|/animes/<slug>/`; **episodios generados con conteos exactos de TMDB** + patrón de slug verificado (`/episodio/<show>-temporada-N-episodio-M/`) — Ally McBeal: 112 eps exactos, streams por episodio resueltos en vivo (8 fuentes).
- **Pipeline paralelo**: descubrimiento y guardado simultáneos (productor-consumidor con cola y reanudación crash-safe).

## 6. Dedup, secuelas y reconciliación

- **`titleNormalizer`** (`server/utils/titleNormalizer.ts`): `parseRawTitle` (canonical/year/language/quality/season/plausible), `normalizeTitleKey` (clave de fusión), `isPlausibleTitle` (guard anti-basura: "pe", "Género:...", URLs de debug; conectado en `saveShowWithDeduplication`).
- **Secuelas NUEVAS**: `mergeSequelIntoTwin` — si el import trae un `tmdb_id` que ya pertenece a otra obra, se multiplexa DENTRO de ella (episodios con numeración continua + fuentes bajo la temporada correspondiente). Cero tarjetas duplicadas.
- **Reconciliación de secuelas EXISTENTES** (`POST /api/v1/catalog/reconcile-sequels`, dry-run por defecto): agrupa por `tmdb_id`, fusiona con **guardas de similitud de títulos** (Jaccard normalizado; umbrales: película 0.5, serie con marcador 0.3, serie sin marcador 0.5). Ejecución real: **22 fusiones, 146 episodios reubicados, 22 tarjetas eliminadas, 40 pares dudosos descartados** a revisión manual.
- **Fusión manual**: `POST /api/v1/catalog/merge-works {keep_id, merge_id, dry_run?}` para pares de idioma distinto que las guardas no se atreven a tocar (Rent-a-Girlfriend = Novia de Alquiler S2, To Your Eternity = Fumetsu no Anata e S3, etc.).

## 7. Índice de re-escaneo (hiper-rápido)

- `quickSyncKnownShow` (`showService`): para obras YA conocidas, compara la lista de episodios de la ficha contra la BD e inserta **solo los faltantes** — sin TMDB, sin enrichment, sin re-guardado (~2-4s/obra vs 10-30s).
- Cableado en DOS sitios:
  - **Workers**: rama ligera en el guardador antes del pipeline pesado (log `Conocida 'X': +N episodio(s) nuevo(s)`).
  - **Verificación**: fase de novedades con flag `sync_known_episodes` (default ON, checkbox en UI); contador `new_episodes` en el progreso.
- Los streams de los episodios nuevos se resuelven **Just-In-Time** al reproducir (o con "Refrescar streams" del editor).

## 8. Verificación automática (nueva pestaña)

- `server/verificationWorker.ts` + rutas `GET /api/v1/verification`, `POST .../config`, `POST .../run`.
- Recorre obra por obra según scope (**todo / por plataformas / por categoría**) y hace: (1) re-colecta metadatos (`backfillShow`), (2) detecta novedades en las plataformas seleccionadas (re-barre sus catálogos; lo nuevo se importa con dedup).
- **Timer persistente** (`data/verification.config.json`): cada X minutos/horas/días/meses, ON/OFF; progreso en vivo con contadores y mini-log.
- UI: pestaña "Verificación" en el Admin.

## 9. Backfill + reparaciones

- **`backfillShow`** completa SOLO campos vacíos con datos reales (nunca defaults falsos: rating 8.0 / "Finalizado" / "Multimedia" no son datos).
- **Descripciones truncadas**: elipsis final = descripción débil → la completa de TMDB la reemplaza (115 obras detectadas para reparar; corren con `POST /api/v1/metadata/backfill`).
- **Reparación de títulos**: ruido estructural ("X Latino Español HD", "Ver X online") → título canónico validado con `isPlausibleTitle`; sincroniza el MediaItem espejo; **sin tocar claves de dedup** (normalizeTitleKey ya ignora ese ruido).
- **Géneros siempre en español** + traductor resiliente (reintento 429 + MyMemory) + rescate de overviews vacíos (Cinecalidad).

## 10. Write-buffer (outbox para BD lenta)

- `server/writeBuffer.ts`: si la SQLite está lenta/bloqueada (p.ej. barrido pesado en paralelo), las actualizaciones de metadatos van a `data/write-buffer.jsonl` y un **drenador** (60s + al boot) las aplica solas cuando la BD responde. Dedup por fingerprint, máx 5 intentos.
- `backfillShow` escribe diferido en fallo; `GET /api/v1/write-buffer` expone el estado.
- SQLite endurecida: `DATABASE_URL="file:./dev.db?connection_limit=1&pool_timeout=30"` (adiós "database is locked" con barridos a fondo).

## 11. Editor de catálogo por obra

- `PUT /api/v1/shows/:id`: edita TODOS los campos; si cambia el título recalcula claves canónicas (mismo pipeline que el dedup).
- `POST /api/v1/shows/:id/refresh-streams`: re-resuelve servidores de cada episodio en background y sincroniza SourceLinks.
- `GET /api/v1/shows/:id` ahora incluye `media_item_id` (relación por clave canónica) → el modal muestra **plataformas donde está disponible ese título** (agrupa `play-multi` por `source_site`).
- UI: botón "Editar" por obra en la pestaña Catálogo → `ShowEditModal`.

## 12. Admin exclusivo en `/admin`

- **Login minimalista** (`POST /api/v1/admin/login`, credenciales en `ADMIN_USER`/`ADMIN_PASS` de `.env`, defaults `uziel`/`uziel20082`); sesión en sessionStorage.
- `main.tsx` enruta: `/admin` → `AdminGate` (login + panel); la página principal **ya no expone ningún acceso** al panel (botón del header eliminado; las tarjetas del empty-state redirigen a `/admin`).
- Vite `appType: "spa"` sirve `/admin` sin cambios de servidor.

## 13. UI miscelánea

- Etiquetas de tipo SIEMPRE en español (`contentLabel`): "movie" → "Película" (MediaCard, HeroBanner, BentoCollection, MediaDetailsModal).
- Prioridad de plataformas reordenable con flechas ↑↓ en la tab Fuentes (intercambia SiteRating; empates empujan 0.5).
- Fix del botón "Rastrear Catálogo" del Extractor (estado React stale que disparaba un job default de animeflv) → ahora lleva a Ingesta de Lotes con la URL precargada.

## 14. Infraestructura / acceso externo

- Túneles cloudflared permitidos en CORS: `classifieds-discounts-father-barrier` y `bookstore-britain-lows-locked` (`app.config.ts`).
- URLs del reproductor/proxy ahora son **relativas** (`/api/...`): funcionan igual en local y a través de cualquier túnel (antes un dispositivo remoto resolvía 127.0.0.1 contra sí mismo).

## 15. Estado final verificado

- `tsc --noEmit`: OK. Vitest: 87+ tests (titleNormalizer 36, metadataEngine 30+, taskWorker, resolvers, streamSorter, VideoExtraction).
- Servidor reiniciado y sano; jobs pausados reanudados correctamente; reconciliación ejecutada (22 merges reales).
- **Pendientes conocidos**: pares de idioma distinto sin fusionar (usar `merge-works`), migración opcional de `page_concurrency`/`item_concurrency` a BD (hoy en memoria), backfill masivo de las 115 descripciones truncadas (un POST lo lanza).
