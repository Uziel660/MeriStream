# Trabajo 2 — Reproductor frontend: caducidad, proxy y failover determinista

**Dificultad:** media-alta  
**Responsable:** otra IA  
**Objetivo:** hacer que el reproductor use correctamente el contrato backend, sin ciclos automáticos ni intentos inútiles sobre enlaces ya vencidos.

## Propiedad exclusiva de archivos

Puedes modificar únicamente:

- `src/api/client.ts`
- `src/components/HLSPlayerModal.tsx`
- `src/utils/playerDelivery.ts`
- `src/utils/playerDelivery.test.ts`
- `src/utils/streamOptimizer.ts`
- `src/utils/streamOptimizer.test.ts`
- `src/utils/deliveryCapabilities.ts`
- `src/utils/deliveryCapabilities.test.ts`

No modifiques `server/`, `prisma/`, `tools/`, `package.json`, configuración, Docker, estilos globales ni otros componentes.

## Contrato backend que debes consumir

La resolución puede incluir:

```ts
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

Si el backend todavía no expone uno de estos campos durante tu trabajo, tipa el campo como opcional y usa un fallback conservador; no edites el backend.

## Máquina de estados obligatoria

```text
resolving
  → trying_direct
  → playing_direct
  → requesting_proxy
  → playing_proxy
  → playing_embed
  → awaiting_manual_choice
  → error
```

Reglas:

1. `expired_without_locator` jamás entra en `trying_direct` ni `requesting_proxy`.
2. Si existe otro servidor, avanzar una sola vez al siguiente; si no existe, mostrar un error honesto de reimportación pendiente.
3. Un fallo directo puede escalar a proxy únicamente si `is_proxyable !== false`.
4. Proxy fallido puede avanzar al siguiente servidor una sola vez.
5. Un iframe/embed no cambia automáticamente de servidor por timeout; ofrece elección manual.
6. Todo callback, promesa y temporizador debe estar protegido por `attemptId`.
7. Un servidor no puede intentarse más de una vez por modo dentro del mismo intento de reproducción.
8. La clave de conexión debe incluir URL, generación y delivery mode.
9. La renovación preventiva solo se programa si existe `refresh_after` y `is_refreshable=true`.
10. Una sesión proxy no se recarga preventivamente desde el frontend; el backend administra su URL actual.

## Rendimiento

- No hacer health-check antes de adjuntar la primera fuente.
- El health-check debe ser informativo y ejecutarse después, con máximo cuatro candidatos.
- No usar un watchdog menor de cinco segundos para el primer manifiesto.
- Cancelar timers/listeners/HLS al cerrar o cambiar de intento.
- No agregar dependencias.
- No hacer polling.

## Mensajes mínimos de UI

- Fuente vencida sin origen: `Esta fuente antigua necesita reimportarse.`
- Proxy ocupado o rechazado: `No se pudo usar el proxy. Puedes probar otro servidor.`
- Embed silencioso: botones `Mantener` y `Cambiar al siguiente servidor`.
- Nunca mostrar “Backend falló” para un `expired_without_locator`.

## Pruebas obligatorias

Añade o ajusta pruebas puras para:

1. Vencido sin locator salta directo y proxy.
2. Vigente proxyable/no renovable permite proxy después de fallo directo.
3. Renovable programa renovación.
4. Proxy no renovable no programa renovación frontend.
5. Callback tardío de un servidor anterior se ignora.
6. Misma URL con nueva generación se reconecta.
7. Timeout de iframe no produce failover automático.
8. Ningún servidor repite el mismo modo en un intento.

Ejecuta al final:

```text
npx vitest run src/utils/playerDelivery.test.ts src/utils/streamOptimizer.test.ts src/utils/deliveryCapabilities.test.ts
npm run lint
npm run build
```

## Límites estrictos

- No modifiques backend ni esquema de BD.
- No reimportes datos.
- No ejecutes Playwright ni pruebas live contra CDNs.
- No cambies diseño visual fuera de los mensajes y controles especificados.
- No reviertas cambios preexistentes.
- Si necesitas editar fuera del allowlist, detente y repórtalo.

## Prompt listo para usar

Trabaja en `C:\Users\Uziel\Desktop\Meristream`. Implementa exclusivamente el “Trabajo 2 — Reproductor frontend: caducidad, proxy y failover determinista” descrito en este archivo. Solo puedes tocar los ocho archivos del allowlist. Otros agentes trabajan simultáneamente; no modifiques, reviertas ni reformatees ningún archivo ajeno. Consume el contrato `PlaybackResolution` de forma compatible y conservadora. Elimina ciclos de failover: una fuente vencida sin localizador no debe intentar directo ni proxy; un directo vigente puede pedir proxy solo si es proxyable; los embeds nunca cambian automáticamente por timeout. Mantén protección `attemptId`, limpieza total de recursos y conexión por URL+generación+modo. No uses Playwright, no pruebes CDNs reales, no reimportes y no agregues dependencias. Ejecuta exactamente las pruebas, lint y build indicados. Si la solución exige tocar backend u otro archivo, detente y reporta el bloqueo. Entrega archivos modificados, matriz de estados verificada, comandos ejecutados y limitaciones.
