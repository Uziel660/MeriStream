# Runbook de Auditoría y Reimportación Canónica

Este documento describe el procedimiento operativo seguro, reanudable e idempotente para auditar y reimportar el catálogo de fuentes canónicas en **Meristream**, optimizado para no saturar memoria ni CPU en hardware de recursos limitados (ej. ASUS T100TA).

---

## Principios y Restricciones Operativas

1. **Memoria acotada (< 150 MB):** Todo el procesamiento se realiza en streaming paginado por lotes (máximo 50 registros por lote). Nunca se cargan 125.000 episodios en un solo arreglo de memoria.
2. **Concurrencia máxima de 2:** Nunca exceder 2 tareas concurrentes de red o base de datos.
3. **Modo seguro por defecto:** La herramienta opera siempre en `--dry-run` a menos que se indique explícitamente `--apply`.
4. **Idempotencia estricta:** Repetir la ejecución de cualquier lote o registro genera 0 duplicados en la base de datos.
5. **No eliminación automática:** Las filas de las tablas legacy (`Show`, `Episode`) jamás se borran ni modifican automáticamente durante la reimportación.
6. **Exclusión de fuentes efímeras:** Ninguna URL de streaming directo firmada con parámetros de expiración (`s+e`, `expires`, `token`, `jwt`) se almacena como fuente canónica permanente.
7. **Privacidad de tokens:** Los tokens de firma y autenticación nunca se imprimen completos en logs ni reportes JSON.

---

## Procedimiento Paso a Paso

### Paso 1: Respaldo de PostgreSQL realizado manualmente por el usuario

Antes de cualquier operación que involucre escrituras o cambios de versión en la base de datos, el usuario debe realizar un volcado completo de la base de datos PostgreSQL:

```bash
# En el servidor PostgreSQL o máquina host:
pg_dump -h localhost -U postgres -d meristream -F c -b -v -f "backup_meristream_pre_reimport_$(date +%Y%m%d_%H%M%S).dump"
```

Verificar que el archivo de respaldo exista y tenga un tamaño consistente antes de proseguir.

---

### Paso 2: Despliegue y pruebas del Trabajo 1 (Núcleo backend canónico)

Verificar que el backend tenga confirmados y probados los contratos de resolución JIT y persistencia canónica:

```bash
npx vitest run server/resolvers.test.ts server/resolutionMetadata.test.ts server/deliveryPlanner.test.ts server/playbackSessions.test.ts
npm run lint
```

Confirmar que todos los tests pasen exitosamente y que no haya errores de compilación o tipo.

---

### Paso 3: Auditoría inicial de fuentes

Ejecutar la herramienta de auditoría de solo lectura para obtener el estado basal del catálogo:

```bash
npx tsx tools/audit_stream_sources.ts --report reports/audit_pre_reimport.json
```

**Métricas generadas:**
- Total de episodios legacy.
- Total de `SourceLink` multi-origen.
- Directos estables vs. firmados vigentes vs. firmados vencidos.
- Vencidos con fuente hermana canónica (recuperables) vs. sin fuente recuperable.
- Desglose por host y plataforma.
- Muestra de hasta 20 ejemplos anonimizados.

---

### Paso 4: Piloto en modo simulación (`--dry-run --limit 50`)

Ejecutar un piloto de simulación sobre los primeros 50 registros para verificar la lógica de mapeo sin realizar escrituras en la base de datos:

```bash
npx tsx tools/reimport_canonical_catalog.ts --input data/canonical_catalog.json --limit 50 --dry-run --report reports/pilot_dry_run.json
```

**Validación:**
- Revisar que `dry_run: true` esté reflejado en el reporte.
- Verificar que las fuentes efímeras firmadas hayan sido excluidas y contabilizadas correctamente en `excluded_ephemeral_sources`.
- Confirmar que no ocurran errores de parsing ni excepciones no controladas.

---

### Paso 5: Piloto con escritura (`--apply --limit 50`) con autorización explícita

Únicamente tras validar el paso anterior y contar con autorización explícita, ejecutar el piloto con persistencia real acotado a 50 registros:

```bash
npx tsx tools/reimport_canonical_catalog.ts --input data/canonical_catalog.json --limit 50 --apply --batch-size 25 --concurrency 1 --cursor-file checkpoints/cursor_pilot.json --report reports/pilot_apply.json
```

**Validación:**
- La herramienta confirmará la disponibilidad del contrato backend antes de iniciar.
- Se guardará un cursor atómico en `checkpoints/cursor_pilot.json`.

---

### Paso 6: Revisión de métricas y reproducción manual

1. Consultar en la base de datos o API la existencia de los nuevos `MediaItem`, `MediaEpisode` y `SourceLink`.
2. Probar la reproducción en el reproductor frontend o vía endpoint de resolución JIT (`/play` o `/api/playback/resolve`) para confirmar que las fuentes canónicas (`page`, `embed`, `stable_direct`) resuelven correctamente los streams temporales bajo demanda.

---

### Paso 7: Reimportación completa reanudable

Una vez validado el piloto, ejecutar la reimportación completa con soporte de reanudación automática por cursor y tolerancia a interrupciones (`Ctrl+C`):

```bash
npx tsx tools/reimport_canonical_catalog.ts --input data/canonical_catalog.json --apply --batch-size 25 --concurrency 1 --cursor-file checkpoints/cursor_catalog.json --report reports/reimport_full_report.json
```

**Comportamiento ante interrupción:**
- Si el proceso se detiene o se envía `Ctrl+C` (`SIGINT`), la herramienta esperará a completar el lote en curso, escribirá el checkpoint atómico en `checkpoints/cursor_catalog.json` y saldrá de forma limpia.
- Al reiniciar el comando con el mismo `--cursor-file`, reanudará exactamente a partir del siguiente registro sin repetir ni duplicar los ya confirmados.

---

### Paso 8: Auditoría final

Ejecutar nuevamente la auditoría de solo lectura para cuantificar las mejoras y verificar la cobertura:

```bash
npx tsx tools/audit_stream_sources.ts --report reports/audit_post_reimport.json
```

Comparar `reports/audit_pre_reimport.json` con `reports/audit_post_reimport.json` para constatar:
- Aumento de `SourceLink` canónicos válidos (`page`, `embed`, `stable_direct`).
- Reducción o cobertura de episodios con URLs previamente vencidas.

---

### Paso 9: Limpieza legacy como proyecto separado (NUNCA automática)

- Las filas de `Episode` y `Show` de la arquitectura legacy se mantienen intactas como salvaguarda de compatibilidad hacia atrás.
- Cualquier migración, archivado o depuración de filas legacy debe planificarse como un proyecto separado e independiente, tras un período de observación en producción y con respaldo verificado.
- **Bajo ninguna circunstancia las herramientas de reimportación deben eliminar filas automáticamente.**

---

## Referencia de Comandos Rápidos

```bash
# Ver ayuda de auditoría:
npx tsx tools/audit_stream_sources.ts --help

# Ver ayuda de reimportación:
npx tsx tools/reimport_canonical_catalog.ts --help

# Ejecutar suite de pruebas:
npx vitest run tools/reimport_canonical_catalog.test.ts
```
