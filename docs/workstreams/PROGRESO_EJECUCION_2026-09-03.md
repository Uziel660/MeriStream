# Progreso de ejecución — 2026-09-03

Última actualización: 2026-09-03 (hora local del entorno).

## Procesos persistentes

- Servidor API/frontend: activo en `http://127.0.0.1:3010`.
- Reparación TMDB: la primera pasada terminó y la segunda pasada reanudable
  (`data/tmdb-repair-sweep2.cursor.json`) está completando los títulos que se
  incorporaron durante la reimportación. No se fusionan temporadas hasta que
  ambos cursores estén en `done`.
- Recuperación canónica: cola `recovery-1788414964297-mxxrp`, modo `all`,
  TubePelis excluido. La cola anterior de expirados terminó y esta conserva
  checkpoints por episodio.
  La instancia API actual ya fue recargada con el worker multi-candidato; la
  cola reanudó desde su checkpoint sin duplicar lo ya procesado.
- El finalizador quedó ejecutándose y espera sin crear colas duplicadas: primero
  cerrará los catálogos, después TMDB/reconciliación y por último una pasada
  final de recuperación y verificación.
- Cierre automático: `tools/finalize-catalog-pipeline.ts` espera a que todos
  los `full_catalog` terminen; reintenta una vez los fallidos (excepto
  TubePelis), espera la reparación TMDB y cualquier recuperación `all` ya
  activa, ejecuta una reparación TMDB final sobre el catálogo ya cerrado,
  luego la reconciliación de Shows/MediaItems y guarda
  `docs/reports/tmdb-reconcile-final.json`; después crea una sola pasada final,
  espera su finalización y lanza la verificación completa.

## Cambios verificados en esta etapa

- Fallback de deduplicación restringido por categoría.
- Reconciliación TMDB protegida por namespace: anime/series (TV) sí pueden
  converger cuando son la misma obra; una película y una obra TV con el mismo
  entero TMDB nunca se fusionan automáticamente.
- La reimportación canónica ahora acepta `tmdb_id`, hereda la identidad desde
  el Show legacy y reutiliza el `MediaItem` por TMDB antes de probar título/año.
- El backfill normal también espeja un TMDB recién encontrado al `MediaItem`
  equivalente, para que la identidad no vuelva a quedar desalineada.
- Ese espejo comparte el namespace TV entre `anime` y `series`, pero mantiene
  las películas separadas para no unir obras con el mismo entero por accidente.
- La reconciliación TMDB ahora cubre también duplicados de `MediaItem` (no solo
  carteles `Show`): mueve episodios y SourceLinks por temporada y borra el
  duplicado únicamente después de copiar todas sus fuentes.
- Temporadas explícitas `S2/S3` conservan el Show/MediaItem y se escriben en
  la temporada correcta durante guardado y reescaneo.
- El reescaneo conocido de una S2/S3 también anexa su episodio al modelo legacy
  (que no tiene columna de temporada), evitando que choque con el episodio 1 de
  la S1; la numeración de temporada permanece en `MediaEpisode`.
- Películas conocidas se reanalizan para añadir fuentes de cada proveedor.
- El presupuesto de runtime reserva un solo carril para una resolución JIT
  iniciada por el usuario incluso bajo presión de memoria; los sondeos y
  trabajos especulativos siguen limitados para no degradar el servidor.
- La creación de sesión proxy ya no tiene un guard previo que bloquee ese
  carril interactivo cuando el runtime está saturado; la admisión se decide en
  un único punto y conserva el límite de una resolución de usuario a la vez.
- El modal HLS conserva la interfaz compacta, pero sus controles reciben un
  área táctil mínima de 40 px y respetan el área segura inferior/superior de
  móviles; la validación visual en navegador queda para la prueba final con
  el servidor recargado.
- La ficha de cada obra normaliza etiquetas claramente contaminadas por el
  scraper (por ejemplo `Capitulo 1S1.E117 de Mayo del 2026`) a `Episodio N`
  sin modificar el título original almacenado; quedó cubierto con pruebas.
- Los embeds ahora consideran cargado el documento al recibir `onLoad`, lo que
  evita falsos avisos de “stall” en reproductores cross-origin que no exponen
  eventos `playing`; el cambio manual de servidor permanece disponible.
- La ficha tolera títulos de episodio ausentes o nulos al detectar temporadas y
  películas; ya no puede romperse por un `.match` sobre `undefined`.
- Los buffers de log del worker tienen una ventana máxima por tarea; si la BD
  tarda en drenar, el progreso no puede acumular mensajes ilimitados en RAM.
- La recuperación canónica dejó de leer la cola JSON completa en cada episodio;
  consulta solo el estado y el delay, reduciendo el I/O repetido y evitando que
  una cola grande congele el avance.
- El crawler masivo cede el pool mientras recovery está activo y cada episodio
  de recuperación tiene un timeout de 60 s; un proveedor lento ya no puede
  bloquear indefinidamente las demás fuentes.
- Se añadió `tools/backfill-legacy-source-links.ts`, una pasada por lotes que
  enlaza episodios históricos que aún no tenían `SourceLink`, con match seguro
  por TMDB/namespace/título-año, cursor atómico y modo dry-run por defecto. Su
  ejecución completa queda programada después de cerrar los workers actuales.
- Tras un reinicio del equipo se confirmó la reanudación desde checkpoints: la
  recuperación `recovery-1788414964297-mxxrp` terminó en **28.352/28.352**
  (28.348 recuperados), la API fue levantada de nuevo y las tareas de catálogo
  huérfanas se reencolaron automáticamente. La reparación TMDB se reanudó desde
  `data/tmdb-repair-sweep2.cursor.json` sin reiniciar el lote.
- El finalizador se reinició de forma controlada para incorporar el puente
  legacy como etapa automática: tras cerrar catálogos, TMDB, reconciliación y la
  recuperación final, ejecutará `backfill-legacy-source-links` con cursor y
  reporte antes de lanzar la verificación completa.

### Prueba visual y de reproducción (servidor recargado)

- Vista móvil (390×844): catálogo, búsqueda, ficha y controles se muestran sin
  desbordes; la captura quedó validada en la sesión del navegador.
- TioAnime/Frieren: reproducción HLS nativa a 720p, 37 s observados, `readyState`
  4 y más de 10 min de buffer, sin errores de consola.
- Cinecalidad/Romeo debe morir: reproducción HLS nativa, 17 s observados,
  `readyState` 4, 60 s de buffer y sin errores.
- HiAnimes/Hero Without a Class: el embed cross-origin cargó su reproductor y
  continuó más de 2 min sin el falso aviso de stall; el selector manual sigue
  disponible.
- Sesión proxy JIT: HTTP 201 y manifiesto HLS HTTP 200 con `#EXTM3U` bajo la
  presión real del runtime; no se reprodujo `backend_busy`.
- Recuperación persistirá todos los candidatos canónicos válidos del episodio;
  checkpoints grandes cada 25 elementos reducen I/O sin perder idempotencia.
- AnimeFLV acepta búsquedas por título y devuelve candidatos JKanime canónicos.

## Verificación

- `npx vitest run`: 60 archivos, **610/610**; suite específica `showService`:
  **10/10** tras el ajuste de reescaneo S2.
- `npm run lint`: limpio.
- `npm run build`: frontend y backend compilados; solo permanecen los avisos
  heredados de sintaxis CSS y tamaño de chunk.
- Verificación repetida tras el puente legacy, el filtro de namespace del puente
  de reproducción y el ajuste de throttling: `npx vitest run` volvió a cerrar
  **60 archivos / 610 tests sin fallos**; `npm run build` también terminó con
  código 0 y únicamente los dos avisos heredados.

La reparación TMDB y los catálogos se ejecutan en segundo plano con cursores y
checkpoints. El informe de cada pasada queda en `docs/reports/`; la fusión
destructiva solo se ejecuta cuando no hay escritores concurrentes y siempre
después de copiar las fuentes al episodio destino.

### Estado operativo (03-09-2026, 14:12 UTC)

- La recuperación `recovery-1788414964297-mxxrp` sigue avanzando sin errores:
  **16.801/28.352** episodios procesados y **16.798** recuperados. El servidor
  API responde con salud HTTP 200 y el consumo del proceso se mantiene estable
  alrededor de 0,6–0,8 GB de memoria privada.
- La segunda pasada TMDB está en conflictos **4.112/5.278**; el finalizador
  permanece vivo y espera ambos procesos antes de fusionar identidades o lanzar
  la verificación final.
- Los trabajos `full_catalog` permanecen pendientes por el guard de prioridad;
  se reanudarán cuando termine la recuperación para no competir por el pool de
  PostgreSQL ni disparar solicitudes duplicadas a los proveedores.

## Reanudación segura

No borrar los archivos `data/tmdb-repair*.cursor.json` ni las tareas de
`CrawlTask`. Si el proceso se reinicia, el servidor reencola trabajos huérfanos
y cada importación/recuperación es idempotente por sus claves de base de datos.

### Estado operativo actualizado (03-09-2026, después del reinicio del equipo)

- El servidor volvió a levantarse en `127.0.0.1:3010` y `GET /api/v1/health`
  responde **200/ok**.
- La reparación TMDB se reanudó desde su cursor y alcanzó aproximadamente
  **12.900/24.569** elementos sin reiniciar la pasada.
- Las dos reimportaciones TioPlus siguen procesándose de forma persistente:
  Series (**1.328 shows / 8.845 episodios**) y Películas (**2.946 shows / 874
  episodios** en sus colas actuales). Las demás tareas pendientes quedan
  serializadas para no competir por el pool ni sobrecargar el servidor.
- El finalizador permanece activo y ejecutará, en orden, la reparación TMDB
  final, reconciliación, recuperación de fuentes, puente legacy y verificación.
- Se corrigió el orden inicial del reproductor: si una respuesta trae un HLS
  directo junto a un embed, el directo se prueba primero; los embeds reales y
  las páginas canónicas quedan como fallback estable. La prueba específica y
  el build vuelven a pasar.
- Se silenció por defecto el log de deduplicación por elemento durante las
  importaciones masivas (`MERISTREAM_VERBOSE_DEDUP=1` lo reactiva), reduciendo
  I/O de consola sin quitar warnings ni errores operativos.

### Estado operativo actual (03-09-2026, 16:02 UTC)

- TioPlus Películas continúa en ejecución (**6.238 shows / 1.977 episodios**
  confirmados en la última lectura) y Doramasflix Doramas también avanza
  (**2.679 shows / 17.573 episodios**). Hay seis colas pendientes que el
  trabajador tomará al liberar cada slot.
- El finalizador sigue esperando únicamente a que `full_catalog` termine; no
  ha creado colas duplicadas ni ha iniciado todavía la fusión final.
- La sonda HLS ahora rechaza manifests vacíos que responden 200 (solo
  `#EXTM3U`/versión), evitando que enlaces CDN muertos entren al ranking como
  saludables. Se añadieron pruebas y **9/9** pasan; el cambio se aplicará al
  servidor al próximo reinicio controlado, después de cerrar los catálogos.
- `npm run lint` y `npm run build` vuelven a terminar correctamente tras el
  ajuste de la sonda; solo permanecen los avisos CSS/chunk ya conocidos.

### Estado congelado para traslado (03-09-2026)

- Se detuvieron servidor, trabajadores y finalizador de forma intencional para
  trasladar el entorno sin escrituras concurrentes. Las dos tareas que estaban
  `running` se devolvieron a `pending`, conservando sus checkpoints.
- La rama remota `codex/catalog-recovery-transfer-2026-09-03` contiene el código,
  esquemas, `.env` ya versionado, dump/snapshots, `dist`, reportes, cursores y
  `database/snapshots/crawl-tasks-transfer-20260903.json` con las 33 colas.
- La exportación NDJSON de toda la base actual superó el límite de 30 minutos en
  `MediaEpisode`; por eso el traslado combina el dump/snapshot completo más
  reciente disponible con el estado operativo exacto de `CrawlTask`. Para una
  copia 1:1 de los registros actuales, la nueva PC debe apuntar al mismo
  `DATABASE_URL`; con una base nueva, restaura el dump y deja que las tareas
  `pending` terminen los registros posteriores.

### Reanudación local — 2026-09-03 21:26 (America/La_Paz)

- Se confirmó la rama `codex/catalog-recovery-transfer-2026-09-03` y el árbol de
  trabajo permanece sin cambios de código.
- Dependencias reinstaladas con `npm ci` y Prisma Client regenerado.
- El contenedor existente `voidstream-pg` se inició sin recrearlo; conserva su
  volumen persistente y publica `localhost:5433 -> PostgreSQL:5432`.
- `.env` se ajustó para usar `DATABASE_URL` en `localhost:5433`. La conexión
  Prisma fue validada contra `voidstream`; no se restauró `meristream_prod.dump`
  porque la base ya contiene datos.
- Conteos de lectura: `Show=19.812`, `MediaItem=20.980`,
  `MediaEpisode=78.117`, `SourceLink=6.700`, `CrawlTask=9`; las 9 tareas están
  `completed`. No hay servidor escuchando en `3010` ni se iniciaron workers.
- Se realizó la sustitución solicitada de la base local: se eliminó la base
  anterior `voidstream` y se creó una nueva con el mismo propietario; después se
  restauró `meristream_prod.dump` de esta rama (`pg_restore exit=0`). El respaldo
  previo permanece en `meristream_pre_replace_20260903.dump`.
- Validación posterior a la restauración: base de 93 MB con 10 tablas;
  `Show=19.787`, `MediaItem=20.989`, `MediaEpisode=78.152`,
  `SourceLink=6.700`, `CrawlTask=11`; las 11 tareas están `completed`.
- Prisma conecta por `localhost:5433`; no hay migraciones Prisma en el proyecto
  y no se ejecutó ninguna migración destructiva adicional. No hay servidor ni
  workers Node activos.
- Pendiente inmediato: ejecutar lint, suite completa y build antes de levantar
  la API; no iniciar una reimportación desde cero.

### Estado de colas transferido — 2026-09-03 21:45 (America/La_Paz)

- Se leyó `database/snapshots/crawl-tasks-transfer-20260903.json` y se validó
  el formato esperado (`meristream-crawl-task-state-v1`) con 33 tareas.
- Se hizo `upsert` idempotente de las 33 tareas sobre la base restaurada,
  conservando `items_queue`, `logs`, contadores, fechas y checkpoints. No se
  lanzaron scrapers ni workers durante la operación.
- Validación exacta: 33 tareas en la base (`22 completed`, `5 failed`,
  `6 pending`), cero diferencias campo a campo; hash SHA-256 canónico del
  snapshot y de la base: `c4010b8551528865361cb959dce1b97997290e55261ceb2ae62c2755a6f1d035`.
- La base queda lista para reanudar únicamente las 6 tareas `pending` después
  de arrancar la API y revisar sus proveedores; las 5 `failed` no se reintentan
  automáticamente hasta clasificar el error.

### Verificación posterior a la restauración — 2026-09-03 21:39 (America/La_Paz)

- `npm run lint`: correcto.
- Pruebas dirigidas: 6 archivos, 99 pruebas correctas.
- Suite no-live (`npx vitest run --exclude "tests/scrapers/**"`): 46 archivos,
  517 pruebas correctas.
- `npm run build`: correcto; permanecen únicamente el aviso heredado de CSS y
  el aviso de chunk grande.
- La suite completa se inició, pero las pruebas live de proveedores externos
  quedaron esperando respuestas más allá del límite operativo de esta sesión;
  se detuvo esa ejecución sin modificar código ni datos. Debe repetirse cuando
  se quiera auditar proveedores con red disponible.

### Puente legacy completado — 2026-09-04 02:07 (America/La_Paz)

- El `dry-run` completo recorrió 123.305 episodios legacy en 5,0 s: 119.188
  emparejados, 6 excluidos por TubePelis, 2.745 efímeros, 677 sin `MediaItem`,
  689 ambiguos y 0 errores.
- Se optimizó `tools/backfill-legacy-source-links.ts` con índices por namespace,
  título y TMDB, y procesamiento concurrente acotado a 32 filas (el máximo
  estable medido contra `max_connections=100`).
- Antes de aplicar se sincronizó el esquema Prisma con `npx prisma db push`:
  el dump histórico no incluía las columnas nuevas de `SourceLink` (incluido
  `source_status`), pero no se perdió ningún dato.
- La aplicación idempotente terminó en el cursor
  `data/legacy-source-bridge.cursor.json` (`123.305/123.305`) con 0 errores:
  89.304 enlaces nuevos y 89.836 episodios multi-fuente nuevos en el tramo
  principal; los lotes piloto añadieron el resto.
- Conteos posteriores: `Show=19.787`, `MediaItem=20.989`,
  `MediaEpisode=120.161`, `SourceLink=117.796`, `CrawlTask=33`.
  Las tareas siguen `22 completed`, `5 failed`, `6 pending`; no se iniciaron
  workers durante el puente.

### Worker reanudado y ajuste de rendimiento — 2026-09-04

- Se configuró el worker para el máximo operativo medido sin sobrecargar el
  proceso: `max_concurrent_jobs=8`, `page_concurrency=8` e
  `item_concurrency=16`, con `default_delay_ms=0` y el control anti-bot por
  proveedor aún activo. Las seis tareas pendientes se reanudan en paralelo;
  las cinco fallidas permanecen clasificadas y no se reintentan solas.
- El primer arranque con el límite heredado de Node (`384 MB`) alcanzó el
  límite de heap al levantar las seis colas. No hubo corrupción de PostgreSQL;
  los jobs quedaron como `running` para recuperación automática.
- Se elevó inicialmente el límite de heap a `4096 MB`; la recuperación funcionó,
  pero las colas grandes llevaron el proceso hasta ~4,8 GB privados. Se detuvo
  de forma controlada antes de otro OOM y se elevó el límite de producción a
  `8192 MB` en `npm run start`.
- En cada reinicio la recuperación reencola correctamente los seis jobs y
  resetea sus ítems `processing`; `/api/v1/health` responde `ok`. PostgreSQL
  conserva `22 completed`, `5 failed`, `6 running` y los checkpoints no se
  pierden.
- Con `8192 MB` el uso se estabilizó alrededor de 2 GB privados durante la
  ejecución observada; los seis jobs muestran checkpoints nuevos y no se
  reprodujo el OOM.
- La medición también registró picos transitorios de ~6 GB con seis jobs
  activos. Por eso `max_concurrent_jobs=8` queda como techo seguro (ya cubre
  todas las colas pendientes); subirlo a 12–24 aumentaría el riesgo de OOM y
  saturación externa sin acelerar este lote actual.
- Se añadió un timeout JIT de 18 s para `/catalog/episode-servers` y
  `/resolve-embed`: una fuente externa que no responde ya no puede dejar el
  reproductor en el spinner de resolución indefinidamente; la UI muestra el
  error y permite reintentar o pasar al siguiente servidor.
- Se dejó iniciado `npm run finalize:pipeline`; actualmente espera a que los
  seis `full_catalog` activos terminen y luego ejecutará la secuencia final del
  handoff (reparación TMDB, recuperación, reconciliación y verificación).

### Auditoría de cobertura y contadores — 2026-09-04

- Conteo global actual, independiente de cualquier worker: `Show=19.793`,
  `MediaItem=21.007`, `MediaEpisode=120.377` y `SourceLink=118.038`. La cifra
  de ~19.800 obras sí está presente después de la fusión.
- Los contadores visibles dentro de una tarea (`total_discovered`,
  `shows_imported`, `episodes_imported`) son del lote y de la ejecución actual;
  no representan el total global ni restan registros existentes. Cuando una
  obra ya existe, el worker registra `re-escaneo ligero, +0 episodio(s)` y
  conserva los episodios previos.
- Las tareas históricas completadas contienen los barridos grandes: por
  ejemplo `www3.animeflv` (3.571 obras/23.483 episodios), `wwv.veranimes`
  (4.180/34.652), `tioanime.com` (3.859/35.761), `tioplus.app` (600/8.664),
  `doramasflix` (2.745/18.182) y `lamovie.org` (7.279/3.359). La fusión
  deduplica esas fuentes en los 19.793 `Show` globales.
- Cinco de los seis jobs activos tienen el marcador de descubrimiento completo:
  sus colas de 154, 260, 972, 1.107 y 1.537 obras se están procesando, no
  limitando el catálogo a una o dos páginas. `TioPlus Películas` aún está en
  descubrimiento y va por la página 475 con 11.351 obras en cola.
- `full_catalog` usa `max_pages=0` y el código recorre hasta página vacía,
  repetición confirmada o el fusible de 10.000 páginas; no existe un límite de
  1–2 páginas. Los cinco `failed` visibles son intentos históricos que
  devolvieron catálogo vacío (`el adaptador no devolvió elementos de catálogo`),
  no pérdida de los catálogos completados; el finalizador los reintentará una
  vez (excepto TubePelis) al terminar los seis activos.

### Corrección de fuentes Anime y estabilidad — 2026-09-04

- Se comprobó contra los proveedores vivos que `www3.animeflv.net/browse`
  responde 521 y `tioanime.com/browse` responde 404. El inicio futuro usa
  `https://animeflv.or.at/anime/` (126 fichas actuales, 7 páginas) y
  `https://tioanime.com/directorio` respectivamente; no se borra el catálogo
  histórico ya fusionado de AnimeFLV/TioAnime.
- JKanime (`https://jkanime.net/directorio/`) expone su catálogo en JSON
  embebido, no como tarjetas HTML. Se añadió un parser sin ejecución de JS
  remoto para `var animes`; fue comprobado en páginas 1, 2 y 164 con 30, 30 y
  6 fichas, que corresponden a sus 4.896 títulos publicados. El job **JKanime
  (Catálogo Completo)** quedó creado y activo.
- HiAnimes devuelve HTTP 500 desde su página 18 en sus dos APIs disponibles.
  El worker ya no marca ese caso como catálogo completo tras cinco errores:
  conserva el checkpoint, drena lo descubierto y lo deja pausado para reintento.
  La tarea quedó pausada en página 17/260 en vez de presentar cobertura falsa.
- Se fijó el máximo efectivo en seis jobs, que fue el máximo sostenido sin
  presión de memoria excesiva. Al reiniciar se pausaron el espejo AnimeFLV
  pequeño y HiAnimes para que no se restauren ocho procesos a la vez; están
  preservados y reanudables.
- Se corrigió el respaldo JSONL del buffer de escritura: ya no concatena el
  archivo completo en una sola cadena V8 (causa de `Invalid string length`),
  sino que agrega lotes de 500 operaciones y reencola un lote si falla el disco.
  `server/writeBuffer.test.ts` pasa (5/5); el build y la prueba del verificador
  pasan también (15/15). El servidor nuevo responde `GET /health` con 200 en
  `localhost:3010`.
- El finalizador fue detenido de forma intencional mientras se clasifican estas
  fuentes; no está autorizado a reintentar URLs históricas inválidas ni a
  declarar completado un proveedor con errores.
- En la primera ejecución masiva JKanime respondió Cloudflare HTTP 429 con el
  `delay=0`. La tarea se dejó **pausada** y con delay propio de 1.500 ms en vez
  de forzar páginas parciales; su compatibilidad de extracción/paginación quedó
  comprobada previamente, pero se reanudará solo cuando el proveedor acepte el
  ritmo.

### Matriz de reproducción, TubePelis y detección de idioma — 2026-09-05

- Se ejecutó `npx tsx tools/playback-platform-matrix.ts` con concurrencia 2 y
  sólo lectura: 12/12 plataformas respondieron HTTP 200 con candidatos y seis
  episodios multiplexados (9–14 sitios, 21–33 enlaces) respondieron 200 con
  3–8 candidatos. El detalle sin URLs firmadas está en
  `docs/workstreams/playback-platform-matrix-2026-09-05.md`.
- TubePelis tenía seis episodios legacy sin `SourceLink`; su dry-run del puente
  (`--site tubepelis.com --limit 10`) emparejó los seis sin ambigüedades ni
  errores. Se eliminó la exclusión histórica del puente y se dejó un filtro por
  sitio para aplicar ese lote después de que el finalizador quede inactivo.
- La prueba live del adaptador TubePelis resolvió 4/4 películas a manifiestos
  HLS. La prueba live de VerAnimes resolvió 3/3 episodios con servidores
  alternativos. Estas sondas no escriben en la base.
- `detectLanguageHints` ahora distingue estrictamente `Sub Español` de audio
  doblado; el test exige que no se asigne `audio_language` en ese caso.
  `npm run lint` y la suite dirigida de idioma pasan.
- Pendiente seguro: esperar el fin del proceso global/finalizador, aplicar el
  puente TubePelis con cursor nuevo, reiniciar el API una sola vez para cargar
  los cambios, ejecutar la auditoría de salud de fuentes y cerrar con lint,
  suite, build y regresión visual.

### Auditoría adicional 2026-09-05

- Suite completa repetida tras el cambio del adaptador AnimeFLV: **62/62
  archivos, 626/626 tests**.
- AnimeFLV/JKAnime ahora usa el directorio JKAnime como fallback si el espejo
  WordPress no responde; la suite live `AnimeFlvOrAt` quedó 4/4.
- Auditoría ligera de idioma/assets (solo lectura): 37,232 fichas Show; 30,301
  con TMDB (81.38%), 36,412 descripciones sustantivas (97.8%), 2,917 marcadas
  probablemente no españolas por la heurística conservadora, 37,230 posters y
  37,215 banners/backdrops. MediaItem: 38,161 elementos, 26,790 TMDB (70.2%),
  37,814 posters (99.09%) y 11,827 backdrops (30.99%).
- Se añadió `tools/metadata-language-audit.ts` para repetir esta medición por
  cursor sin cargar el catálogo completo; el resultado queda en
  `docs/workstreams/metadata_language_audit_2026-09-05T06-40-38-109Z.md`. La
  reparación completa de los faltantes queda pendiente de ejecutarse cuando
  finalice la verificación global.

### Actualización de verificación — 2026-09-05 07:13Z

- La matriz se repitió excluyendo el alias sintético `test-index.local`:
  **18/18** casos correctos (12 proveedores y 6 multiplexados), HTTP 200 y
  candidatos > 0. Latencia: 23 ms mediana, 41,2 ms promedio y 112 ms P95.
- La suite completa actual quedó en **62/62 archivos y 626/626 pruebas**.
- El API en ejecución sigue siendo el proceso anterior mientras la verificación
  global termina; por eso aún no se ha reiniciado ni ejecutado la sonda de bytes.
  La última lectura del verificador fue fase `catalog`, 0 errores, con el total
  creciendo dinámicamente. Después de `idle` se aplicará el puente TubePelis,
  se reiniciará el API una sola vez y se repetirá el smoke E2E/fallback canónico.
