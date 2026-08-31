# Trabajo 3 — Herramientas reanudables de auditoría y reimportación

**Dificultad:** media-baja, tediosa y repetitiva  
**Responsable:** otra IA  
**Objetivo:** crear herramientas seguras para medir, simular y posteriormente reimportar el catálogo sin cargar todo en RAM ni castigar el ASUS T100TA.

## Propiedad exclusiva de archivos

Puedes crear o modificar únicamente:

- `tools/audit_stream_sources.ts` (nuevo)
- `tools/reimport_canonical_catalog.ts` (nuevo)
- `tools/reimport_canonical_catalog.test.ts` (nuevo)
- `docs/REIMPORT_CANONICAL_RUNBOOK.md` (nuevo)

No modifiques ningún archivo existente fuera de esa lista. En particular: no toques `server/`, `src/`, `prisma/`, `package.json`, Docker, `.env` ni scripts existentes.

## Contrato de entrada

La herramienta debe trabajar con registros normalizados:

```ts
interface CanonicalImportRecord {
  title: string;
  kind: "movie" | "series" | "anime";
  year?: number;
  season?: number;
  episodes: Array<{
    number: number;
    title?: string;
    canonical_sources: Array<{
      url: string;
      source_site: string;
      source_kind: "page" | "embed" | "stable_direct";
    }>;
  }>;
}
```

Puede reutilizar funciones públicas existentes mediante imports, pero no puede modificarlas. Si el contrato backend aún no está disponible, conserva un adaptador pequeño dentro de `tools/reimport_canonical_catalog.ts` y documenta la espera; no invadas archivos ajenos.

## Herramienta de auditoría

`audit_stream_sources.ts` debe ser siempre de solo lectura y producir JSON más resumen humano con:

- total de episodios legacy;
- total de `SourceLink`;
- directos estables;
- firmados vigentes;
- firmados vencidos;
- vencidos con fuente canónica hermana;
- vencidos sin fuente recuperable;
- desglose por host y plataforma;
- máximo 20 ejemplos anonimizados o truncados, sin imprimir tokens completos.

Debe procesar por páginas/lotes; está prohibido cargar 125.000 episodios completos en una sola matriz.

## Herramienta de reimportación

`reimport_canonical_catalog.ts` debe tener obligatoriamente:

- modo predeterminado `--dry-run`;
- `--apply` explícito para escribir;
- `--source <id>` para limitar plataforma;
- `--batch-size`, predeterminado 25 y máximo 50;
- `--concurrency`, predeterminado 1 y máximo 2;
- `--cursor-file <ruta>` para reanudar;
- `--limit <n>` para piloto;
- `--report <ruta>` para JSON final;
- reintentos máximos 2 con backoff acotado;
- checkpoints atómicos después de cada lote;
- manejo de `Ctrl+C` que termine el lote actual y guarde cursor;
- idempotencia: repetir el mismo lote no crea duplicados;
- nunca persistir `ephemeral_direct` como fuente canónica;
- nunca borrar automáticamente filas legacy.

La herramienta debe rechazar `--apply` si no puede confirmar que el contrato backend de fuentes canónicas está disponible. No debe ejecutar migraciones.

## Límites para el ASUS T100TA

- Memoria objetivo menor de 150 MB para la herramienta.
- Concurrencia máxima dura de 2.
- Sin Playwright, Chromium, workers de navegador ni descargas de segmentos.
- No guardar HTML completo.
- Máximo 50 escrituras por lote.
- Liberar estructuras de cada lote antes de continuar.

## Pruebas obligatorias

1. `--dry-run` no ejecuta ninguna escritura.
2. `--apply` sin contrato backend confirmado se niega a empezar.
3. Concurrencia mayor de 2 se recorta o rechaza.
4. Batch mayor de 50 se recorta o rechaza.
5. Un HLS firmado se excluye de `canonical_sources`.
6. Reanudar desde cursor no repite lotes confirmados.
7. Interrupción guarda cursor válido.
8. Tokens de URLs no aparecen completos en reportes.
9. Repetir un lote conserva idempotencia.

Ejecuta al final únicamente:

```text
npx vitest run tools/reimport_canonical_catalog.test.ts
npx tsx tools/audit_stream_sources.ts --help
npx tsx tools/reimport_canonical_catalog.ts --help
```

No ejecutes `--apply` ni una auditoría completa.

## Runbook requerido

`docs/REIMPORT_CANONICAL_RUNBOOK.md` debe documentar este orden:

1. respaldo de PostgreSQL realizado manualmente por el usuario;
2. despliegue y pruebas del Trabajo 1;
3. auditoría inicial;
4. piloto `--dry-run --limit 50`;
5. piloto `--apply --limit 50` solo con autorización explícita;
6. revisión de métricas y reproducción manual;
7. reimportación completa reanudable;
8. auditoría final;
9. limpieza legacy como proyecto separado, nunca automática.

## Límites estrictos

- No escribas en la BD durante esta tarea.
- No ejecutes `--apply`.
- No borres ni marques filas existentes.
- No cambies esquema, backend o frontend.
- No añadas dependencias ni scripts a `package.json`.
- No reinicies, despliegues ni abras navegador.
- No reviertas cambios preexistentes.
- Si necesitas editar fuera del allowlist, detente y reporta el bloqueo.

## Prompt listo para usar

Trabaja en `C:\Users\Uziel\Desktop\Meristream`. Implementa exclusivamente el “Trabajo 3 — Herramientas reanudables de auditoría y reimportación” descrito en este archivo. Solo puedes crear o tocar los cuatro archivos del allowlist. Otros agentes trabajan en backend y frontend: no edites, reviertas ni reformatees sus archivos. Construye una auditoría paginada de solo lectura y una reimportación reanudable cuyo modo predeterminado sea `--dry-run`, con lote máximo 50, concurrencia máxima 2, checkpoints atómicos, reportes sin tokens e idempotencia. La herramienta debe negarse a ejecutar `--apply` si el contrato backend canónico no está disponible. No ejecutes importaciones reales, no escribas en BD, no uses Playwright, no agregues dependencias y no cambies `package.json`. Ejecuta únicamente la prueba y los dos `--help` especificados. Si necesitas cualquier archivo adicional, detente y explica el bloqueo. Entrega los cuatro archivos, pruebas exactas y ejemplo de comandos seguros, sin haber alterado datos.
