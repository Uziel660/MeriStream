# Avance — Parte 1: fuentes canónicas y resolución JIT

Última actualización: 2026-09-01 (America/La_Paz)

## Objetivo

Evitar que URLs HLS firmadas y efímeras se almacenen como identidad permanente, preservar páginas/embeds renovables y mantener sesiones proxy ligeras para el ASUS T100TA.

## Estado actual

- Fase: Partes 1, 2 y 3 integradas y validadas de forma estática; pendiente únicamente la operación manual y autorizada de auditoría/reimportación.
- Documento rector: `docs/workstreams/01_BACKEND_CANONICAL_JIT.md`.
- Proyecto del grafo: `C-Users-Uziel-Desktop-Meristream`.
- Generación observada: `2026-08-31T00:28:48Z`.
- Cobertura: sin huecos registrados en los archivos objetivo, pero todos reportaron `metadata_changed`; se debe tratar la fuente local como autoridad.
- Árbol de trabajo: ya estaba ampliamente modificado antes de iniciar esta fase. Está prohibido revertir cambios ajenos.

## Evidencia confirmada

- 125.997 episodios legacy medidos.
- 2.747 URLs directas firmadas con `s+e`; 2.745 vencidas.
- Solo 15 episodios vencidos tienen una fuente canónica equivalente.
- `BaseScraperAdapter.extractStream()` resuelve embeds durante la importación y puede descartar el origen renovable.
- Una URL firmada vigente debe poder ser `is_proxyable=true` aunque `is_refreshable=false`.
- Existe un ajuste parcial local en `server.ts`, `server/playbackSessions.ts` y su prueba para permitir sesiones cortas con URLs firmadas vigentes. Debe preservarse y verificarse.

## División de trabajo

- Subagente `/root/canonical_persistence`: dejó cambios en tipos, persistencia, scraper base y `server/canonicalSources.test.ts`. Ya no está activo; falta validar e integrar su resultado.
- Subagente `/root/resolution_sessions`: dejó la semántica `is_proxyable`/`is_refreshable` en resolvers, planner, sesiones y pruebas. Ya no está activo; falta ejecutar la batería completa.
- Subagente `/root/integration_audit`: ya no está activo y su respuesta final no llegó al buzón por la interrupción del turno. El agente principal hará la auditoría de rutas directamente.
- Agente principal: propietario de `server.ts`, integración final, conflictos y validación completa.

## Plan de validación final

```text
npx vitest run server/resolvers.test.ts server/resolutionMetadata.test.ts server/deliveryPlanner.test.ts server/playbackSessions.test.ts server/canonicalSource*.test.ts
npm run lint
npm run build
```

## Validación ejecutada

### Actualización de integración (2026-09-01)

- Se corrigió un ciclo de imports introducido por la resolución JIT de páginas de plataforma; el scraper se carga de forma diferida y los adaptadores vuelven a inicializar correctamente.
- La cascada DB-only descarta índices de catálogo (`/page/N/`, raíces e índices conocidos) y conserva las páginas de detalle para resolución JIT.
- La auditoría distingue `active_ephemeral_direct` de `expired_ephemeral_direct`; una firma sin expiración demostrable ya no se marca como vencida.
- El reproductor resuelve solo el candidato activo, no sobrescribe el índice 0 y no envía páginas canónicas a HLS.js; los fallos JIT muestran reintento/cambio manual.
- Se blindaron las entradas de `ResolutionCoordinator` contra valores no string para evitar el error `undefined.trim` de sesiones ligeras.
- Auditoría de solo lectura regenerada: 6.164 enlaces, 329 directos vencidos y 1 índice de catálogo inválido; no se modificó la base.
- Pruebas completas: **562/564 aprobadas**. Las 2 restantes son las fallas preexistentes de traducción de géneros (`Action & Adventure`) en `server/metadataEngine.test.ts`.
- `npm run lint`: aprobado. Build frontend y bundle backend: aprobados; solo avisos preexistentes de CSS/chunk grande.
- Verificación HTTP real con el servidor reiniciado: página LaMovie/CineCalidad → resolución directa `proxy_required` → sesión 201 → manifiesto HLS 200.

- `npx vitest run server/resolvers.test.ts server/resolutionMetadata.test.ts server/deliveryPlanner.test.ts server/playbackSessions.test.ts server/canonicalSources.test.ts`
  - Resultado: 5 archivos, 58 pruebas, todas aprobadas.
  - Duración: 74,17 s.
- `npm run lint`
  - Resultado: aprobado sin errores.
- Tras integrar `refreshShowStreams` y las rutas HTTP se repitió la batería:
  - Resultado final: 5 archivos, 62 pruebas, todas aprobadas.
  - `npm run lint`: aprobado sin errores.
- `npm run build`: aprobado; conserva dos avisos preexistentes (regla CSS inválida y chunk frontend mayor a 500 kB).
- Verificación posterior al rebase de recursos absolutos: 3 archivos/39 pruebas aprobadas, `npm run lint` aprobado y `git diff --check` sin errores.
- Integración de Partes 1–3: 9 archivos de prueba, 118 pruebas aprobadas; `npm run lint` y `npm run build` aprobados.

## Cambios integrados por el agente principal

- `refreshShowStreams` conserva la página/embed original y cualquier directo estable; excluye `ephemeral_direct` antes de sincronizar `SourceLink`.
- `GET /api/v1/play/:episode_id` en el esquema multi-fuente ahora es DB-only: ordena y devuelve locators canónicos, sin disparar hasta cuatro extractores en cada apertura.
- Cada candidato multi-fuente expone `original_url`, `canonical_locator`, `is_proxyable`, `is_refreshable` y `delivery_mode`.
- `POST /api/v1/playback/sessions` rechaza explícitamente resoluciones no proxyables y devuelve `failure_reason`; una URL firmada vigente sigue pudiendo crear una sesión corta.
- `buildNormalizedEpisodes` ya no permite que una firma efímera quede como `Episode.source_url`; si también existe una página/embed canónico, esa identidad pasa a ser la primaria legacy.
- `quickSyncKnownShow` pasa por el mismo normalizador canónico y la clasificación derivada de la URL prevalece sobre cualquier `source_kind` entregado por un scraper.
- Un embed que produzca media ya vencida se mantiene como locator renovable, pero no se anuncia como stream reproducible.
- Los recursos HLS absolutos conservan su URL durante la generación actual y, tras renovar, se reconstruyen con directorio/host/token de la nueva raíz en vez de repetir el recurso que devolvió 403.
- La cascada DB-only marca `expires_at`/`expired_without_locator` de directos efímeros sin efectuar red y consulta ratings una sola vez.
- El frontend consume todo el contrato de resolución, incluidos `empty_locator`, `is_proxyable`, `is_refreshable`, `generation` y `delivery_mode`.
- La reimportación conserva `page`, `embed` y `stable_direct` como `link_type` correcto, con `page` explícito en vez de degradarlo a `direct`.

## Restricciones activas

- No borrar ni truncar datos; las reimportaciones futuras requieren dry-run y autorización explícita.
- Reiniciar el servidor únicamente después de cambiar código y validar el health-check; no desplegar ni reimportar datos automáticamente.
- No modificar frontend, herramientas ni adaptadores específicos.
- No ejecutar Playwright/Chromium.
- No agregar dependencias.

## Limitaciones y siguiente paso

- Las filas legacy que aún contienen HLS vencidos no se modificaron; las 92 coincidencias recuperables ya tienen una página canónica en `MediaEpisode + SourceLink`.
- El camino legacy de `/play` conserva su resolución anterior por compatibilidad; el camino `MediaEpisode + SourceLink` ya es DB-only y será el camino normal después de reimportar.
- Se reinició el proceso local de 3010 para cargar el código integrado y se verificó `/health`; no se ejecutó Playwright/Chromium.
- Siguiente paso operativo: resolver los episodios sin coincidencia canónica mediante descubrimiento controlado por proveedor; cada nueva pasada debe empezar en dry-run.

## Historial

- Se creó este archivo de continuidad antes de iniciar cambios nuevos de la Parte 1.
- Se delegaron tres ámbitos sin solapamiento. Los workers fueron advertidos de que comparten el árbol y de que la fuente local prevalece porque el grafo reportó `metadata_changed`.
- Tras una interrupción por mensaje del usuario, los subagentes dejaron de aparecer activos. Sus cambios sí quedaron en el árbol compartido.
- Se confirmó en fuente local la presencia de `SourceKind`, `CanonicalSourceInput`, `is_proxyable`, `failure_reason`, filtrado de `ephemeral_direct` y nuevas pruebas `server/canonicalSources.test.ts`.
- Se detectaron además archivos de los otros trabajos (`tools/audit_stream_sources.ts`, `tools/reimport_canonical_catalog.ts`, su prueba y el runbook). Son propiedad de otras IAs y no se tocarán en la Parte 1.
- La batería backend acotada aprobó 58/58 pruebas.
- La primera revisión final agregó el guard de `Episode.source_url`; una auditoría independiente detectó seis huecos adicionales y todos fueron corregidos. La batería cerró en 62/62 y lint aprobado.

## Reimportación canónica ejecutada (2026-09-02)

- Se hizo primero una simulación en memoria, sin escrituras, usando únicamente páginas canónicas no firmadas del catálogo legado.
- Se aplicó la reimportación con lotes de 10 y concurrencia 1 para mantener bajo el consumo del servidor ASUS T100TA.
- Resultado: **92 registros procesados, 92 MediaItems reutilizados/actualizados, 92 MediaEpisodes y 92 SourceLinks canónicos**.
- No se guardó ninguna URL HLS firmada, no se eliminaron enlaces existentes y no hubo errores ni registros omitidos.
- Fuentes recuperadas: TioPlus, LaMovie y CineCalidad; las páginas se guardaron como `link_type=page` para que el backend las resuelva JIT.
- Reporte: `docs/workstreams/reimport_canonical_legacy_report.json`.
- Cursor reanudable: `docs/workstreams/reimport_canonical_legacy.cursor.json`.
- Verificación posterior: el episodio de prueba de La captura devuelve candidatos `cinecalidad` y la API de salud del servidor responde `ok`.
- Auditoría posterior: 6.241 enlaces auditados; los 329 directos vencidos siguen presentes como histórico (no se borraron), mientras que 92 episodios ya cuentan con una fuente canónica alternativa utilizable. El contador de reconstrucción por proveedor permanece en 330 porque la auditoría exige una página del mismo sitio; la cascada ya puede utilizar las páginas alternativas reimportadas.
- Verificación HTTP final: `/health` responde `ok`; CineCalidad y LaMovie crean sesión proxy y sus manifiestos HLS responden 200.
- Validación de código posterior: 63 pruebas acotadas aprobadas, `npm run lint` aprobado, build frontend aprobado (solo avisos CSS/chunk preexistentes) y bundle backend aprobado.
- Se omitió deliberadamente el descubrimiento activo de TioPlus por su inestabilidad; la pasada se canceló antes de escribir cualquier dato adicional.
- El proceso local de la API quedó ejecutándose en `http://127.0.0.1:3010` y `/health` responde `ok`.

## Restricciones actualizadas

- La reimportación puntual autorizada ya fue ejecutada; cualquier nueva pasada debe comenzar con otro dry-run y revisión de su conteo.
- El proceso sigue sin borrar SourceLinks: únicamente crea o actualiza coincidencias exactas mediante upsert.

## Continuación operativa (2026-09-03)

- Se actualizó el alcance de recuperación: **TioPlus sí se procesa**; únicamente
  **TubePelis** permanece excluido.
- Se añadió `server/sourceRecoveryWorker.ts` con cola persistente, reanudación,
  pausa/reinicio, límite de 8 candidatos por elemento, verificación JIT de
  páginas existentes y búsqueda exacta controlada para TioPlus/CineCalidad.
- Se añadieron las rutas administrativas `/api/v1/source-recovery/*` y la
  herramienta `tools/run_source_recovery.ts`. El worker usa concurrencia 1,
  espera configurable y temporizador sin bloquear el proceso.
- Smoke autorizado: **5/5** elementos, 0 errores (incluido un enlace TioPlus).
- Recuperación completa autorizada: job
  `recovery-1788396778553-3uavs`, **213/213 procesados, 212 importados, 1
  omitido, 0 errores**. No se borraron enlaces ni se persistieron manifiestos
  firmados; los nuevos registros son páginas/embeds canónicos.
- Se ajustaron los valores iniciales del worker al ASUS T100TA: espera 1.500 ms,
  jitter, una tarea/página/elemento concurrente y rotación de agente.
- Se corrigió el puente legacy en `server.ts`: un `Episode` antiguo busca su
  `MediaEpisode` por TMDB/título/año y devuelve primero SourceLinks canónicos,
  evitando usar como identidad el último `.m3u8` firmado. Si no existe una
  coincidencia segura, se conserva el extractor legacy como último recurso.
- Cuando un sitio tiene página/embed canónico, la cascada ya no expone sus
  manifiestos efímeros históricos como primera opción; el frontend resuelve la
  página y puede crear sesión proxy renovable.
- Pruebas nuevas del puente: 3/3; batería backend relacionada: 57/57; el
  endpoint real para “18 rosas” legacy ahora devuelve la página CineCalidad y
  `media_episode_id`, sin lanzar scrapers.
- Validación en navegador: la reproducción llegó a embed; los logs mostraron
  que la ruta anterior probaba Vimeos firmado y luego saltaba a Goodstream/
  Videoapp. La ruta proxy del backend fue verificada por separado con sesión
  201, manifiesto 200 y recursos HLS 200. Falta repetir la prueba visual tras
  recargar el frontend con el puente recién reiniciado.

## Cierre de validación y continuidad (2026-09-03)

- Se corrigió el límite de recursos de `PlaybackSessionStore` para el endpoint
  real: se pasó a `maxResourcesPerSession=2000` (8 sesiones máximas). El valor
  anterior de 300 podía expulsar los primeros segmentos de una película larga
  antes de que el usuario llegara a ellos, provocando 404 falsos durante el
  avance o el cambio de calidad.
- Validación manual de relay: sesión proxy 201, manifiesto maestro 200,
  manifiesto de nivel 200 y primer segmento 200 (~364 KB) para CineCalidad.
- Validación real en la interfaz con “18 rosas”: el video quedó en modo proxy,
  avanzó de 0:00 a 8:06 (más de 20 s observados después de la carga), sin
  errores recientes ni cambio automático de servidor.
- Auditoría posterior de SourceLinks: 6.337 enlaces. Hay 5.744 páginas
  canónicas, 239 embeds, 24 directos estables y 329 directos firmados vencidos
  conservados como histórico. Los vencidos no se entregan si existe un
  candidato canónico utilizable; se mantienen en DB para trazabilidad y no se
  vuelven a usar como identidad permanente.
- La auditoría por dominio todavía contabiliza 69 episodios de TioPlus sin
  una fuente del mismo dominio, pero la recuperación cruzada ya dejó páginas
  canónicas de CineCalidad/LaMovie para esos elementos cuando hubo coincidencia
  segura. El criterio de reproducción es la cobertura canónica del episodio,
  no la conservación de una CDN firmada de un proveedor concreto.
- Batería focalizada final antes del último caso cruzado: **124/124 pruebas
  aprobadas**; `npm run lint` y
  `npm run build` aprobados. Persisten únicamente los avisos conocidos de CSS
  y del chunk frontend grande.
- El servidor local quedó reiniciado y activo en `http://127.0.0.1:3010`.
  TubePelis continúa excluido explícitamente; TioPlus sí está incluido en la
  cola de recuperación.

## Ajuste final de UX y buffer (2026-09-03)

- Se corrigió un falso overlay: un evento `error` nativo tardío de un intento
  anterior podía mostrar “Ningún servidor automático funcionó” mientras el
  video actual seguía avanzando. Los listeners ahora están ligados a un
  `attemptId`, y cualquier `playing`/`timeupdate` confirmado limpia avisos
  obsoletos.
- Captura visual posterior al ajuste: video visible, 720p, 22:53, 24:36 y luego
  29:40
  de una duración de 2:11:41; no hubo errores nuevos.
- Medición del `<video>` durante reproducción: `readyState=4`, `paused=false`,
  avance real y buffer continuo de aproximadamente **250–310 s** por delante.
  No se observó congelación en la ventana de prueba.
- La prueba de arranque limpia tras reiniciar el servidor volvió a crear la
  sesión proxy y superó 20 minutos acumulados de reproducción.
- Validación de cascada por proveedor (tres muestras por sitio): endpoints 200
  para TioPlus, LaMovie y CineCalidad; el primer candidato fue página/embed
  canónico en todas las muestras. Las resoluciones JIT de CineCalidad fueron
  `resolved=true`, `proxy_required` e `is_proxyable=true` en 0,6–2,9 s.
- Una página de LaMovie que no expone stream en HTML (`Bloodshot`) quedó
  identificada correctamente como embed no resoluble; no se afirma que sea HLS
  funcional hasta que el propio proveedor entregue un locator reproducible.
  El frontend la conserva como fallback controlado y no la presenta como HLS.
- Batería focalizada después de estos cambios: cascada/puente/worker/resolvers/
  sesiones/reproductor, **125/125 pruebas aprobadas**; lint y build aprobados.

## Continuidad — planificación de reescaneo durable en laptop

- Nueva petición: planificar la reconstrucción completa aprovechando la laptop,
  sin aplicar por ahora las restricciones del ASUS. TioPlus incluido; TubePelis
  excluido. No se inició otro barrido ni se modificó código/base de datos en
  este turno de planificación.
- Plan detallado: PLAN_CATALOGO_DURADERO_LAPTOP.md, en este directorio. Incluye
  inventario, contrato de fuentes, adaptadores, cola durable, validación por
  fuente en nuestro reproductor, renovación y mantenimiento incremental.
- Aclaración sobre los resultados previos: importar una página canónica y
  marcar is_verified no prueba que su video se extraiga/reproduzca. El worker
  de recuperación retorna tras la primera alternativa, no tras recuperar
  todos los proveedores originales. Los 212 importados no equivalen a 212
  reproducciones verificadas.
- Las capturas y posiciones avanzadas tras reanudaciones no acreditan 20–31
  minutos continuos ni una renovación real del token. Las pruebas unitarias
  registradas arriba siguen siendo pruebas de código, no cobertura de todo el
  catálogo. La próxima validación medirá tiempo de pared y cuadros presentados.
- LaMovie ya tiene consultas de API implementadas: una ficha sin resolución
  no demuestra por sí sola que el proveedor carezca de video. Debe comprobarse
  toda la ruta del adaptador y la conservación del contexto de cada embed.
- Codebase Memory estuvo indisponible (Transport closed); los hallazgos de
  planificación se apoyaron en lectura de fuente, sin afirmar cobertura total
  del grafo ni nuevas pruebas en vivo.
- Requisito añadido por el usuario: la solución debe ser mantenible. El plan
  prohíbe un resolver/crawler monolítico de miles de líneas; separa contrato,
  adaptadores, cola, comprobación de media, JIT y métricas, comparte utilidades
  y exige dividir módulos nuevos de más de aproximadamente 400–500 líneas.
- Se añadió al plan una fase explícita de completitud de catálogo y fusión:
  comprobar paginación y conteos por adaptador, conservar todas las fuentes de
  cada episodio al reescaneo ligero y verificar la matriz obra/proveedor/
  temporada/episodio con importación idempotente. Una obra fusionada no puede
  perder las fuentes del segundo proveedor ni confundirse por slug/idioma.

## Implementación de completitud y auditoría (2026-09-03)

- Se extrajo `server/catalogFusion.ts` para que la ruta rápida de obras
  conocidas preserve `sources[]` (sitio, host, tipo y evidencia) sin esconder
  esa lógica dentro de `taskWorker.ts`. Sus 3 pruebas cubren varias fuentes,
  URL primaria ausente y entradas vacías.
- Se corrigió el descubrimiento inicial para deduplicar tarjetas por URL
  canónica, y la paginación ahora conserva fingerprints para detectar páginas
  repetidas/solapadas. Esto evita que el fin aparente del catálogo borre
  alternativas de una página posterior.
- Las nuevas SourceLinks de importación llevan `source_status=discovered`,
  `canonical_locator` para páginas/embeds, método `catalog_import` y versión
  `catalog-v2`; nunca se marcan como verificadas por el mero hecho de existir.
- La recuperación canónica reutiliza `canonical_locator` aunque la URL
  histórica sea un manifiesto firmado. Una comprobación fallida posterior no
  degrada una fuente que ya tenía evidencia de media/reproductor.
- Auditoría de adaptadores en vivo (una ficha por preset, sin TubePelis):
  catálogos OK en Doramasflix, LaMovie, Cinecalidad, TioPlus, LatAnime,
  TioAnime y VerAnimes; AnimeFLV devolvió `FETCH_FAILED`; TVMaze y Archive
  son presets de ficha, por eso devuelven cero tarjetas en esa interfaz. Hubo
  directos y embeds en varias muestras, pero Doramasflix solo entregó páginas
  de capítulo en esa pasada. Los reportes `catalog_adapter_audit_*.md/json`
  son diagnósticos y no equivalen a reproducción verificada.
- Auditoría DB-only actual: 21.175 MediaItems, 84.037 MediaEpisodes,
  68.812 episodios sin SourceLink y 881 con más de un proveedor; 22 grupos de
  MediaItem comparten la misma clave normalizada/tipo/año. Esto demuestra que
  el siguiente cuello de botella es completar/reconciliar el inventario de
  fuentes, no seguir ajustando únicamente el selector del reproductor.
- No se inició todavía la reimportación masiva: antes hay que corregir las
  plantillas que devuelven solo páginas, resolver AnimeFLV/TVMaze/Archive por
  su flujo real y convertir la cola de recuperación JSON en checkpoints por
  elemento. TubePelis sigue fuera del alcance y TioPlus dentro.

## Correcciones aplicadas y reimportación iniciada (2026-09-03)

- `DoramasflixAdapter` consulta GraphQL (`user-api.fluxcedene.net`) para
  paginar doramas, películas y variedades. Se eliminaron las páginas duplicadas
  del HTML y se añadieron pruebas con página 1/2, filtros y rutas canónicas.
- `GET /api/v1/play/:episode_id` puentea un `MediaEpisode` sin SourceLinks al
  episodio legacy equivalente y solo usa su localizador para JIT. Si no existe
  ningún localizador, devuelve 404 diagnosticable en vez de `200 + []`.
- `taskWorker` ya no guarda una URL de catálogo como una obra cuando falla el
  análisis inicial o el proveedor devuelve cero tarjetas. La tarea queda
  `failed` y no contamina la base.
- `reimport_canonical_catalog.ts` dejó de marcar como verificadas las fuentes
  importadas: crea `source_status=discovered`, localizador canónico solo para
  página/embed y método/versionado de importación.
- `tools/fast-start.ts` excluye explícitamente TubePelis, incluye las tres rutas
  de Doramasflix y limita la ejecución a dos tareas simultáneas. Se encolaron
  13 barridos `full_catalog`; el servidor fue reiniciado y ya está procesando
  la cola desde PostgreSQL.
- Auditoría viva posterior: Doramasflix 48 elementos únicos en cada pareja de
  páginas; LaMovie, Cinecalidad, TioPlus, LatAnime, TioAnime y VerAnimes sin
  repetición en dos páginas. AnimeFLV devolvió HTTP 521 y no se debe considerar
  un fallo interno ni importar su URL como contenido.

Estado operativo al registrar esta nota: servidor en `127.0.0.1:3010`, una
tarea de catálogo en ejecución y las restantes pendientes en la cola durable.

## Integración HiAnimes y contrato de idiomas (2026-09-03)

- Se añadió `HiAnimesAdapter`, basado en la API pública paginada de
  `animehot.cc` con fallback `anitv.cfd`. Catálogo, fichas y episodios conservan
  las fuentes `sub`/`dub` sin convertir páginas en streams falsos.
- Se añadió la resolución JIT de ZokoAnime: payload XOR/base64, URL HLS
  temporal solo en memoria, cabecera `Referer` del CDN y cierre seguro ante
  payload ausente. HiAnimes `/watch/...` se resuelve por API al hacer play.
- El ranking conserva `link_type`/idioma y el reproductor muestra las fuentes
  de audio/subtítulos disponibles; al cambiar de variante guarda la posición
  actual para restaurarla tras `MANIFEST_PARSED`.
- Los subtítulos que el proveedor entrega se propagan como pistas WebVTT en la
  respuesta de resolución; no se realiza un escaneo global de subtítulos.
- Se corrigió el backfill para incluir explícitamente obras con `tmdb_id` nulo.
  La fusión sigue usando TMDB + tipo + temporada/episodio y conserva los
  SourceLinks de todos los proveedores.
- Verificación de etapa: 82 pruebas enfocadas, `tsc --noEmit`, bundle esbuild y
  `git diff --check` correctos. Pruebas vivas: catálogo HiAnimes (20 elementos),
  detalle de *Your Name.* (1 episodio con sub/dub) y resolución JIT a HLS con
  cabecera Zoko confirmadas.

## Endurecimiento TMDB y JIT canónico (2026-09-03)

- `metadataEngine` ya no acepta ciegamente el primer resultado popular de TMDB:
  puntúa título/original, coincidencia de tokens y año, y rechaza resultados sin
  similitud mínima. Esto evita que una consulta ambigua contamine el ID usado
  por el multiplexor.
- Se corrigieron etiquetas TMDB compuestas (`Acción y Aventura`, `Ciencia
  Ficción y Fantasía`, `Guerra y Política`). La suite global había quedado en
  **599 pruebas: 597 aprobadas y 2 fallos heredados de traducción**; la suite de
  metadata posterior pasa completa (52/52).
- `syncMediaItemSources` hereda el `tmdb_id` del `Show` legacy cuando el
  reescaneo ligero no trae metadata, evitando crear MediaItems paralelos sin
  identidad.
- Se añadió `tools/repair-tmdb-identities.ts` (`npm run repair:tmdb`), con modo
  simulación por defecto, `--apply`, concurrencia acotada, cursor y reporte.
  Repara IDs nulos, revalida grupos duplicados y alinea MediaItems con Shows sin
  borrar datos. Debe ejecutarse por lotes y después revisar el informe de
  conflictos antes de aplicar la reconciliación de temporadas.
- Se corrigió un bloqueo del reproductor: una página canónica marcada como
  `notPlayable` ya no se entrega a HLS.js como manifiesto; se resuelve JIT y
  solo después de obtener una URL nativa se adjunta al elemento de video.
- La cascada DB-only conserva ahora `canonical_locator`/estado de evidencia
  persistidos, incluso si el HLS histórico ya venció; un directo vencido con
  localizador queda como `direct_trial` para renovación JIT, no como iframe.
- Las reimportaciones rellenan idioma, audio, subtítulos y localizador de un
  `SourceLink` existente mediante la cola de escritura, sin resetear su salud.
  El endpoint `/play-multi` devuelve la misma metadata para el panel y el
  reproductor. `/catalog/episode-servers` también propaga metadata JIT de
  HiAnimes (cabecera `Referer` del CDN y pistas VTT) junto al manifiesto directo,
  evitando un 403 por adjuntar la URL sin su contexto HTTP.
- `tools/reconcile-tmdb-seasons.ts` ejecuta la fusión por TMDB en dry-run por
  defecto; la versión apply crea el `MediaItem` canónico si faltaba, soporta
  categorías locales distintas y nunca elimina una fila con fuentes sin un
  destino comprobado.
- La reparación TMDB usa una lista estable (no se desplazan índices al rellenar
  IDs), evita esperas para filas ya identificadas y tiene fallback de cursor para
  Windows. El proceso activo puede reanudarse desde
  `data/tmdb-repair.cursor.json`.

## Reimportación durable y reanudable (2026-09-03)

- La recuperación canónica dejó de resolver externamente cada embed durante la
  reimportación. Las fichas/episodios y embeds ya identificados se guardan como
  `discovered` con `canonical_locator`; la extracción del HLS firmado queda para
  JIT. Esto evita bloquear una cola completa por Cloudflare o por un host lento.
- Se corrigió el caso de series/anime: cualquier localizador canónico se conserva
  directamente, no solo películas y directos estables.
- El worker reencola automáticamente tareas `recovery_running` al iniciar un
  proceso nuevo (el worker anterior ya no existe), preservando el cursor guardado.
- Se creó una primera cola `recovery-1788413671226-qlzvv` (10.000 episodios,
  modo `expired`) y una segunda `recovery-1788414964297-mxxrp` (28.352 episodios,
  modo `all`, TubePelis excluido). Ambas son persistentes en `CrawlTask` y se
  ejecutan secuencialmente con 300 ms de separación.
- En la última comprobación la primera cola estaba activa y avanzando; la segunda
  permanecía pendiente. Los contadores exactos se consultan con
  `GET /api/v1/source-recovery/jobs` o directamente desde el informe de progreso.
- El backfill `npm run backfill:canonical -- --apply --concurrency 4` completó
  15.261 de 15.284 candidatos (23 ya habían sido actualizados por la cola en
  paralelo). Quedaron solo 3 páginas no canónicas sin localizador y 42.998
  páginas/embeds con localizador persistente.
- Auditoría posterior de siete proveedores: 20.196 enlaces revisados; 7.365
  páginas y 8.838 embeds canónicos, 329 directos efímeros vencidos y 330 casos
  que todavía requieren reconstrucción (263 TioPlus, 40 LaMovie y 27
  Cinecalidad). Esos casos están cubiertos por la cola `expired`; no se borran
  automáticamente porque conservan su página hermana o requieren JIT.
- Smoke JIT sin persistir tokens: TioAnime devolvió 3 embeds; LaMovie devolvió
  1 directo + 2 embeds; Cinecalidad devolvió 1 directo + 4 embeds. El manifiesto
  de LaMovie atravesó `/api/v1/proxy/stream` con HTTP 200 y `#EXTM3U` válido.
- Validación posterior a los cambios: `npx vitest run` = **601/601**, `npm run
  lint` limpio y `npm run build` correcto. Solo permanecen el warning CSS heredado
  y el aviso de chunk frontend grande.

## Correcciones adicionales de reanudación y AnimeFLV (2026-09-03)

- La reparación TMDB guarda ahora `conflictIndex` durante la revalidación de
  grupos duplicados; una interrupción ya no reinicia esa fase desde el primer
  Show.
- Se añadieron índices PostgreSQL sobre `Show.tmdb_id` y `MediaItem.tmdb_id`.
  La reconciliación por identidad puede agrupar y buscar sin escanear tablas
  completas; no se modificaron filas de contenido.
- El fallback AnimeFLV→JKanime prueba la ruta vigente `/buscar/<slug>` y el
  formulario antiguo `?q=`, filtra enlaces de navegación y genera variantes de
  nombres/temporada. La prueba viva de `yozakurasan...-2` recuperó un HLS y
  seis respaldos de JKanime; también se reconoce el espejo `animeflv.or.am`.
- La suite enfocada tras estos cambios quedó en **18/18** y el endpoint JIT de
  AnimeFLV respondió `resolved=true` con cinco candidatos ordenados.
- La guarda de reconciliación TMDB compara también títulos originales,
  ingleses y japoneses persistidos; duplicados localizados pueden converger en
  la misma temporada sin bajar la protección contra IDs contaminados.
- Se dejó `tools/finalize-catalog-pipeline.ts` como cierre reanudable: espera
  los `full_catalog`, reencola pausas transitorias y, usando la sesión admin de
  la API ya levantada, crea la recuperación final y lanza la verificación
  integral sin abrir un segundo worker en paralelo.
- El fallback local de deduplicación por título separa películas de TV y permite
  que anime/series compartan namespace cuando TMDB confirma que son la misma
  obra; una película y un anime/serie homónimos ya no se fusionan por título.
- La búsqueda de recuperación amplió sus adaptadores de título (AnimeFLV/JKanime,
  TioAnime, TioPlus y Cinecalidad); los adaptadores sin búsqueda segura no se
  fuerzan para evitar peticiones inútiles y falsos candidatos.
- El fast-path del `taskWorker` aplica la misma guarda al reescaneo de catálogos:
  si hay homónimos de categorías distintas, analiza la ficha en vez de asociar
  episodios/fuentes a la primera fila.
- La recuperación canónica confirma checkpoints grandes cada 25 elementos (en
  lugar de cada 5); los reintentos siguen siendo idempotentes y se mantiene la
  capacidad de pausa/reanudación.
- Cada objetivo de recuperación conserva ahora todos sus candidatos canónicos
  válidos, no solo el primero; así no se pierde diversidad de proveedores o
  idiomas dentro del mismo episodio.
- El guardado con un `tmdb_id` existente y marcador explícito `S2/S3` entra al
  fusionador de temporadas; se añadió una prueba de regresión que verifica que
  la misma obra conserva su identidad y crea el episodio en la temporada 2.
- El reescaneo completo ya no omite películas conocidas: visita su ficha para
  incorporar los servidores de cada proveedor y propaga la temporada detectada
  desde el título/slug, evitando perder alternativas o mezclar S2/S3 en T1.
- Verificación posterior a estos cambios: `npx vitest run` = **605/605**;
  `npm run lint` limpio y `npm run build` correcto (solo los avisos heredados
  del CSS y del tamaño del chunk frontend).

## Ajustes de identidad y cierre (2026-09-03)

- La herramienta `reimport_canonical_catalog` acepta `tmdb_id`, hereda el ID
  desde un Show legacy y reutiliza el `MediaItem` por TMDB antes del fallback
  título/año; las fuentes siguen siendo canónicas y no se convierten en
  URLs firmadas persistentes.
- El backfill de metadatos espeja un TMDB recién encontrado al `MediaItem`
  equivalente para evitar que ambos modelos vuelvan a divergir.
- La reconciliación no fusiona categorías distintas aunque compartan el mismo
  entero TMDB, protegiendo la diferencia entre namespaces de película y TV.
- En un reescaneo conocido de S2/S3, el episodio ya no se descarta por chocar
  con el número 1 de S1 en el modelo legacy; se anexa allí y conserva su
  numeración real en `MediaEpisode`.
- El finalizador espera recuperaciones `all` activas, evita duplicar colas y
  espera la recuperación final antes de iniciar la verificación integral.
- `reconcile-tmdb-seasons` también procesa los grupos duplicados de
  `MediaItem`, conservando temporada/episodio y copiando todos los
  `SourceLink`; el modo dry-run no escribe y el apply elimina solo el
  duplicado ya transferido.
- Suite posterior: **607/607 pruebas**, `npm run lint` limpio y `npm run build`
  correcto.
- El finalizador espera también a que terminen todos los cursores de reparación
  TMDB y lanza una pasada final sobre las obras añadidas durante el crawl antes
  de reconciliar temporadas; deja el resultado en
  `docs/reports/tmdb-repair-final-2026-09-03.json`.
- `RuntimeBudget.tryBeginResolution({ interactive: true })` reserva un único
  carril para el clic explícito de reproducción incluso bajo presión de
  memoria; los health-checks y resoluciones especulativas siguen rechazándose
  para proteger el host.
- La ruta de creación de sesión proxy delega ahora toda la admisión a ese
  carril interactivo; se eliminó la comprobación previa que devolvía
  `backend_busy` antes de poder reservarlo.
- El worker de catálogo ya no añade una espera fija de 2 s entre elementos;
  conserva el límite cortés por dominio y reduce el tiempo total del reescaneo.
