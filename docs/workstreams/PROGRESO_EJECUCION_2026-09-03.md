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
