# Handoff exacto para continuar MeriStream

> Este documento es la fuente de contexto operativo para el siguiente ChatGPT/Codex.
> Léelo completo antes de ejecutar comandos o editar archivos.

## 0. Regla principal

Continúa desde el estado congelado de la rama `codex/catalog-recovery-transfer-2026-09-03` y del commit `4803b2fdbe684ce3a48cd5f43199584030a33fe1`. No hagas `reset --hard`, no borres snapshots/cursors y no reviertas cambios anteriores. El servidor y los trabajadores quedaron detenidos intencionalmente para trasladar el entorno; las tareas que estaban `running` fueron devueltas a `pending` conservando sus checkpoints.

Antes de cambiar código:

1. Ejecuta `git status --short --branch` y `git log -1 --oneline`.
2. Lee este archivo, `TRANSFER_BRANCH_2026-09-03.md` y `docs/workstreams/PROGRESO_EJECUCION_2026-09-03.md`.
3. Comprueba que `DATABASE_URL` apunta al destino correcto y crea un respaldo antes de restaurar una base.
4. Ejecuta primero pruebas dirigidas y un `dry-run`; no lances una reimportación completa hasta validar un lote pequeño.
5. Conserva cambios del usuario y documenta cada etapa en `docs/workstreams/PROGRESO_EJECUCION_2026-09-03.md`.

## Prompt de arranque para el siguiente ChatGPT

Usa este repositorio como fuente de verdad. Lee `CHATGPT_HANDOFF_2026-09-03.md`, `TRANSFER_BRANCH_2026-09-03.md` y el progreso operativo antes de hacer nada. Continúa desde el commit indicado, sin reescribir historia ni eliminar datos. El objetivo es dejar un catálogo multiplexado y un reproductor estable: resolución JIT reutilizable, directos antes de proxy, proxy solo bajo demanda, embeds válidos como fallback, renovación preventiva, recuperación idempotente de fuentes, TMDB/temporadas reconciliados y una experiencia rápida en móvil/tablet. TubePelis queda excluido deliberadamente. TioPlus puede auditarse, pero sus fallos externos no deben atribuirse automáticamente al código propio.

Primero verifica el estado real (Git, base de datos, procesos, cursores y tareas `CrawlTask`). Después ejecuta pruebas y una prueba controlada de reproducción antes de continuar. No prometas que todos los proveedores funcionarán: mide cada proveedor y conserva evidencia. Si encuentras un defecto, reproduce, añade una prueba mínima, corrige en el módulo responsable, ejecuta regresión y registra el resultado. Mantén los módulos pequeños y evita archivos monolíticos.

## Objetivo del producto

- Todas las obras deben conservar y multiplexar las fuentes disponibles por proveedor.
- El endpoint de reproducción debe ser DB-only y entregar metadatos completos; la extracción JIT se hace únicamente al reproducir o durante una cola controlada.
- Las URL firmadas/temporales no se deben tratar como localizadores renovables. Se debe guardar el `canonical_locator` o embed estable y resolver un directo nuevo al iniciar/renovar.
- El reproductor debe intentar HLS directo, escalar a proxy solo si corresponde y dejar un embed real como fallback. Nunca debe saltar servidores en bucle ni cambiar de fuente automáticamente por un timeout de iframe silencioso: el cambio de embed es manual.
- La selección de idioma (audio/subtítulos) debe cambiar de fuente sin perder la posición cuando exista una alternativa compatible. Esta parte sigue pendiente de diseño/prueba completa.
- TMDB es la identidad de multiplexado: películas y TV/anime usan namespaces separados; temporadas y episodios deben conservar su número real.

## Cambios ya implementados

### Frontend

- `src/components/HLSPlayerModal.tsx`: máquina de estados de entrega, conexión por URL+generación+modo, protección contra carreras, watchdog directo de 5 s que solo escala a proxy, preservación de metadatos, resolución JIT y renovación preventiva.
- Los candidatos se construyen desde `ranked_streams` sin perder `canonical_locator`, `resolution_id`, expiración, modo y proveedor.
- Las páginas canónicas no resueltas no se montan como iframe. Solo embeds reales pasan al iframe; el timeout de embed muestra acciones manuales.
- El selector muestra proveedor/source site reales y el orden prioriza HLS directo antes de proxy/embed.
- `src/utils/playerDelivery.ts` contiene lógica pura testeable (`applyResolution`, identidad de conexión, intentos, renovación y validaciones de embed/canónico).
- `src/utils/streamOptimizer.ts` conserva metadata de ranking y evita etiquetas genéricas cuando hay host/source site.

### Backend y datos

- `server/resolutionMetadata.ts`: detecta expiración de URL y el formato Vimeo `s=<inicio>&e=<TTL>` solo cuando ambos parámetros existen.
- `server/resolvers.ts`: un directo firmado válido no se promociona como locator renovable; un directo unsigned estable sí; un directo explícitamente expirado se rechaza.
- `server.ts`: `GET /api/v1/play/:episode_id` es DB-only, conserva todos los links, permite hasta 2 candidatos por `source_site` y 8 globales, excluye directos vencidos sin locator y preserva metadata.
- La cascada no descarta alternativas válidas del mismo sitio antes de tiempo.
- `server/scrapers/hostHealth.ts`: un HTTP 200 con manifest HLS vacío (solo `#EXTM3U`/versión) se considera muerto.
- La identidad de candidato ignora parámetros de firma volátiles para no gastar slots en la misma fuente HLS firmada.
- Hay carril único para una resolución JIT iniciada por el usuario, límites de sondeo y buffers de logs acotados.
- Se añadió `tools/backfill-legacy-source-links.ts` para enlazar episodios históricos sin `SourceLink`, con cursor atómico y `dry-run` por defecto.
- La reconciliación TMDB contempla `MediaItem` duplicados, temporadas explícitas y namespace TV compartido por `anime`/`series`, sin fusionar películas por accidente.

## Archivos y artefactos importantes

- `src/components/HLSPlayerModal.tsx`
- `src/utils/playerDelivery.ts` y `src/utils/playerDelivery.test.ts`
- `src/utils/streamOptimizer.ts`
- `server.ts`
- `server/resolutionMetadata.ts` y sus pruebas
- `server/resolvers.ts` y sus pruebas
- `server/scrapers/hostHealth.ts`
- `tools/finalize-catalog-pipeline.ts`
- `tools/backfill-legacy-source-links.ts`
- `tools/export_transfer_task_state.ts`
- `database/snapshots/crawl-tasks-transfer-20260903.json` (35 MB; 33 colas con `items_queue` y checkpoints)
- `meristream_prod.dump` (dump disponible, no necesariamente contiene los últimos registros)
- `database/snapshots/` (snapshots NDJSON comprimidos)
- `data/` (cursores TMDB y reportes)
- `docs/workstreams/PROGRESO_EJECUCION_2026-09-03.md`

## Estado real al congelar el traslado

- Rama remota: `codex/catalog-recovery-transfer-2026-09-03`.
- Commit: `4803b2fdbe684ce3a48cd5f43199584030a33fe1`.
- Working tree limpio en el momento del congelado.
- No hay servidor, finalizador ni worker Node activos; iniciar procesos solo después de validar entorno y base.
- Las tareas `CrawlTask` que estaban en `running` se dejaron en `pending` para reanudación segura.
- La cola de recuperación canónica llegó a 28.352/28.352 (28.348 recuperados) en el último reporte; confirma el estado en la base antes de asumir que no quedan pendientes.
- La reparación TMDB y los catálogos tienen cursores/checkpoints; no los reinicies desde cero.
- La exportación completa de la base actual superó 30 minutos en `MediaEpisode` y fue descartada. Para una copia 1:1 usa el mismo `DATABASE_URL`; en una base nueva restaura el dump/snapshots y deja que las tareas `pending` completen lo posterior.

## Validación conocida

- Suite completa anterior: 60 archivos y 610 tests sin fallos.
- `npm run lint`: limpio después de los últimos cambios.
- `npm run build`: correcto, con avisos heredados de CSS/chunk grande.
- Pruebas dirigidas de salud/player/optimizer: 64 tests pasados.
- El último ajuste de deduplicación usa timestamps dinámicos en su prueba; vuelve a ejecutar esa prueba y la suite completa después de instalar en la nueva PC.
- Prueba visual registrada: TioAnime/Frieren HLS 720p estable; Cinecalidad/Romeo HLS estable; HiAnimes embed cross-origin estable; sesión proxy JIT HTTP 201 + manifest HTTP 200.

## Preparación en otra PC

```powershell
git clone --branch codex/catalog-recovery-transfer-2026-09-03 https://github.com/Uziel660/MeriStream.git
cd MeriStream
npm ci
npx prisma generate
npm run lint
npx vitest run
```

Configura `DATABASE_URL`, `DIRECT_URL`, `TMDB_API_KEY`, `ADMIN_USER` y `ADMIN_PASS`. El `.env` existente está versionado en el repositorio privado por petición del propietario; trátalo como secreto y rota credenciales si el repositorio o el enlace salen de su control. No copies `node_modules`.

Para una base nueva, verifica dos veces la URL y crea respaldo antes de:

```powershell
pg_restore --clean --if-exists --no-owner --dbname="$env:DATABASE_URL" .\meristream_prod.dump
npx prisma migrate deploy
```

## Orden de continuación recomendado

1. Confirmar base, procesos, cursores y tareas; no iniciar dos finalizadores.
2. Ejecutar pruebas dirigidas y corregir cualquier regresión del traslado.
3. Levantar API/frontend en desarrollo y probar un episodio por proveedor con logs de resolución, proxy, HLS y buffer.
4. Ejecutar `tools/backfill-legacy-source-links.ts --dry-run`; revisar conteos y después correrlo por lotes con cursor.
5. Reanudar `pending` catalog tasks de forma serializada/acotada; excluye TubePelis y evita solicitudes duplicadas.
6. Verificar multiplexado por TMDB, temporadas y número de fuentes por obra antes y después de la pasada.
7. Completar idioma/audio/subtítulos y cambio de fuente con pruebas de navegador; no inventar pistas que el manifiesto no ofrece.
8. Auditar Hianimes, JKanime/AnimeFLV y la lista FMHY al final. Añadir solo proveedores que tengan extractor estable, legalmente accesible y pruebas reproducibles; no añadir relleno.
9. Repetir lint, tests, build y una prueba visual. Registrar métricas y dejar el próximo checkpoint en este documento y en el progreso operativo.

## Límites y decisiones no negociables

- No atribuir un 403/timeout de un proveedor externo al frontend sin guardar evidencia de la respuesta y headers.
- No montar páginas de catálogo como iframe para ocultar una resolución fallida.
- No devolver una URL firmada vencida desde `/play`.
- No hacer scrapers o resoluciones externas síncronas en cada carga de catálogo.
- No lanzar Playwright para todo el catálogo: usar scripts/HTTP y navegador solo para casos representativos.
- No borrar datos, cursores, checkpoints ni fusionar identidades TMDB sin respaldo y prueba.
- Toda modificación debe tener prueba o una reproducción documentada.

## Cómo cerrar una etapa

Al terminar cada etapa, actualiza `docs/workstreams/PROGRESO_EJECUCION_2026-09-03.md` con fecha/hora, archivos tocados, comandos, resultados, conteos y pendientes. Ejecuta al menos la regresión dirigida relacionada; antes de entregar, ejecuta lint, suite completa, build y la prueba visual mínima.

