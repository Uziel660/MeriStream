# Trabajo 1 — Núcleo backend de fuentes canónicas y resolución JIT

**Dificultad:** muy alta  
**Responsable:** Codex principal  
**Objetivo:** impedir que una URL HLS firmada y temporal vuelva a convertirse en la identidad permanente de una película o episodio, manteniendo el backend ligero.

## Evidencia de partida

- Se midieron 125.997 episodios legacy.
- 2.747 URLs directas tenían firma `s+e`; 2.745 ya estaban vencidas.
- Solo 15 de esos 2.745 episodios conservaban una fuente canónica equivalente.
- `BaseScraperAdapter.extractStream()` resuelve embeds durante la importación y devuelve solo URLs finales; esto descarta el origen renovable.
- Una URL firmada vigente es reproducible mediante proxy aunque no sea renovable. El código ya contiene un ajuste parcial para separar `proxyable` de `refreshable`; debe conservarse y verificarse.

## Propiedad exclusiva de archivos

Puedes modificar únicamente:

- `prisma/schema.prisma`
- `server/types.ts`
- `server/showService.ts`
- `server/writeBuffer.ts`
- `server/scrapers/BaseAdapter.ts`
- `server/scrapers/ScraperManager.ts`
- `server/universalScraper.ts`
- `server/resolvers.ts`
- `server/resolvers.test.ts`
- `server/resolutionMetadata.ts`
- `server/resolutionMetadata.test.ts`
- `server/deliveryPlanner.ts`
- `server/deliveryPlanner.test.ts`
- `server/playbackSessions.ts`
- `server/playbackSessions.test.ts`
- `server.ts`
- Nuevas pruebas backend bajo `server/` cuyo nombre empiece por `canonicalSource`.

No modifiques `src/`, `tools/`, `package.json`, archivos Docker, documentación ni adaptadores específicos bajo `server/scrapers/adapters/`.

## Contrato que debes publicar

El backend debe distinguir explícitamente:

```ts
type SourceKind = "page" | "embed" | "stable_direct" | "ephemeral_direct";

interface CanonicalSourceInput {
  url: string;
  source_site: string;
  source_kind: SourceKind;
}

interface PlaybackResolution {
  url: string;
  original_url: string;
  canonical_locator?: string;
  resolved: boolean;
  type: "direct" | "embed";
  delivery_mode: "direct" | "direct_trial" | "proxy_required" | "embed";
  is_proxyable: boolean;
  is_refreshable: boolean;
  resolved_at?: number;
  refresh_after?: number;
  expires_at?: number;
  resolution_id?: string;
  generation?: string;
  requiredHeaders?: Record<string, string>;
  failure_reason?: "expired_without_locator" | "unresolved" | "unsafe_url";
}
```

Los nombres pueden adaptarse al estilo existente, pero la semántica no puede mezclarse:

- `is_proxyable`: el backend puede retransmitir la URL actual.
- `is_refreshable`: existe una página/embed/localizador estable para pedir otra URL después.
- Una URL firmada vigente: proxyable, no necesariamente renovable.
- Una URL firmada vencida sin localizador: no resuelta, no proxyable y no renovable.

## Implementación requerida

1. Preservar la URL de entrada del catálogo y los embeds encontrados antes de resolverlos.
2. Clasificar URLs firmadas como efímeras mediante la lógica central de expiración; no duplicar parsers.
3. Prohibir que `ephemeral_direct` sea la única fuente canónica persistida.
4. Permitir `stable_direct` como fuente canónica.
5. Mantener la URL resuelta temporal en caché/sesión, no como identidad permanente.
6. Hacer la escritura idempotente por obra, temporada, episodio, sitio y URL canónica.
7. Mantener compatibilidad de lectura con filas legacy; una fila firmada vencida debe quedar marcada como no reproducible y nunca generar un intento inútil de proxy.
8. Mantener `ResolutionCoordinator` con single-flight y caché acotada.
9. Mantener `PlaybackSessionStore` en memoria, máximo acotado, sin Redis ni procesos externos.
10. Asegurar que una URL firmada vigente pueda crear una sesión corta aunque no tenga `canonical_locator`.
11. No ejecutar Playwright/Chromium en la ruta de reproducción ni en producción.
12. Exponer en las respuestas existentes los campos del contrato sin crear una segunda API paralela.

## Restricciones de rendimiento

- Ninguna sonda HTTP debe bloquear el Time-To-First-Byte de `/play`, `/resolve-embed` o `/playback/sessions`.
- No cargar el catálogo completo en RAM.
- No introducir polling global.
- No más de 128 resoluciones en caché y 64 sesiones proxy, salvo que un límite existente sea menor.
- No descargar segmentos para comprobar salud.
- No guardar cuerpos de manifiestos en PostgreSQL.

## Pruebas obligatorias

1. Importar página → embed → HLS firmado conserva página/embed como fuente canónica.
2. Importar HLS firmado sin origen no lo promueve a fuente permanente.
3. HLS `s+e` vencido nunca crea sesión.
4. HLS `s+e` vigente sí crea sesión proxy corta aunque `is_refreshable=false`.
5. Fuente estable sin firma sigue funcionando.
6. Dos resoluciones simultáneas del mismo locator realizan un solo trabajo.
7. La caché y las sesiones respetan sus límites.
8. La lectura de filas legacy no lanza excepciones por metadatos ausentes.

Ejecuta al final:

```text
npx vitest run server/resolvers.test.ts server/resolutionMetadata.test.ts server/deliveryPlanner.test.ts server/playbackSessions.test.ts server/canonicalSource*.test.ts
npm run lint
npm run build
```

## Límites estrictos

- No borres, trunques ni reimportes la base de datos.
- No reinicies ni despliegues el servidor.
- No cambies el reproductor frontend.
- No reviertas cambios preexistentes.
- Si el trabajo requiere modificar un archivo fuera de la lista, detente y repórtalo; no lo edites.
- No declares éxito si falta alguna prueba obligatoria.

## Prompt listo para usar

Trabaja en `C:\Users\Uziel\Desktop\Meristream`. Implementa exclusivamente el “Trabajo 1 — Núcleo backend de fuentes canónicas y resolución JIT” descrito en este archivo. Eres dueño solo de los archivos enumerados en “Propiedad exclusiva de archivos”. Hay otros agentes trabajando simultáneamente: no reviertas, reformatees ni modifiques sus archivos. Conserva los cambios parciales existentes que separan una URL firmada vigente proxyable de una fuente renovable y verifícalos con pruebas. No ejecutes reimportaciones, migraciones destructivas, despliegues, reinicios ni Playwright. Tu resultado debe preservar la fuente canónica durante la importación, tratar los HLS firmados como caché efímera, mantener compatibilidad legacy y publicar la semántica `is_proxyable`/`is_refreshable`. Ejecuta únicamente las pruebas, lint y build indicados. Si necesitas tocar cualquier archivo fuera del allowlist, detente y explica el bloqueo. Al finalizar, entrega archivos modificados, contrato final, pruebas exactas y limitaciones pendientes.
