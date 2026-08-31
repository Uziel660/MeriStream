# Avance — Parte 1: fuentes canónicas y resolución JIT

Última actualización: 2026-08-31 (America/La_Paz)

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

- No borrar, truncar, migrar ni reimportar datos.
- No reiniciar ni desplegar el servidor.
- No modificar frontend, herramientas ni adaptadores específicos.
- No ejecutar Playwright/Chromium.
- No agregar dependencias.

## Limitaciones y siguiente paso

- Las filas legacy que ya contienen HLS vencidos no se modificaron. Se recuperarán mediante la auditoría/reimportación de la Parte 3.
- El camino legacy de `/play` conserva su resolución anterior por compatibilidad; el camino `MediaEpisode + SourceLink` ya es DB-only y será el camino normal después de reimportar.
- No se reinició el servidor, no se modificó la base y no se ejecutaron pruebas de navegador, conforme a los límites del trabajo.
- Siguiente paso operativo: con respaldo manual de PostgreSQL, ejecutar primero la auditoría de Parte 3 y después un piloto `--dry-run --limit 50`. `--apply` sigue requiriendo autorización explícita.

## Historial

- Se creó este archivo de continuidad antes de iniciar cambios nuevos de la Parte 1.
- Se delegaron tres ámbitos sin solapamiento. Los workers fueron advertidos de que comparten el árbol y de que la fuente local prevalece porque el grafo reportó `metadata_changed`.
- Tras una interrupción por mensaje del usuario, los subagentes dejaron de aparecer activos. Sus cambios sí quedaron en el árbol compartido.
- Se confirmó en fuente local la presencia de `SourceKind`, `CanonicalSourceInput`, `is_proxyable`, `failure_reason`, filtrado de `ephemeral_direct` y nuevas pruebas `server/canonicalSources.test.ts`.
- Se detectaron además archivos de los otros trabajos (`tools/audit_stream_sources.ts`, `tools/reimport_canonical_catalog.ts`, su prueba y el runbook). Son propiedad de otras IAs y no se tocarán en la Parte 1.
- La batería backend acotada aprobó 58/58 pruebas.
- La primera revisión final agregó el guard de `Episode.source_url`; una auditoría independiente detectó seis huecos adicionales y todos fueron corregidos. La batería cerró en 62/62 y lint aprobado.
