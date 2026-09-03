// src/utils/playerDelivery.ts
// Núcleo puro y testeable del bucle de cambio de servidores y entrega del reproductor.
// Toda la lógica de estado (máquina de estados, resolución JIT, metadata, clave de
// reconexión, firma estable de servidores) vive AQUÍ como funciones puras y se consume
// desde HLSPlayerModal.tsx. No depende del DOM ni de React: es directamente testeable.

import type { PlaybackResolution } from '../api/client';
import type { ScoredServer, DeliveryMode } from './streamOptimizer';

export type DeliveryState =
  | 'resolving'
  | 'trying_direct'
  | 'playing_direct'
  | 'requesting_proxy'
  | 'playing_proxy'
  | 'playing_embed'
  | 'awaiting_manual_choice'
  | 'error';

export const DIRECT_WATCHDOG_MS = 5000;
export const DIRECT_BLACK_SCREEN_MS = 6500;
export const EMBED_WATCHDOG_MS = 8000;
export const EMBED_FAILOVER_TIMEOUT_MS = 20000;
export const MAX_PROBE_CANDIDATES = 4;

export const MSG_EXPIRED_WITHOUT_LOCATOR = 'Esta fuente antigua necesita reimportarse.';
export const MSG_PROXY_FAILED = 'No se pudo usar el proxy. Puedes probar otro servidor.';
export const MSG_NO_SERVERS = 'Ningún servidor automático funcionó. Elige uno manualmente:';

export const deliveryModeOf = (mode?: DeliveryMode | string): DeliveryMode | undefined => {
  if (mode === 'direct' || mode === 'direct_trial' || mode === 'proxy_required' || mode === 'embed') {
    return mode;
  }
  return undefined;
};

/**
 * Devuelve la URL que debe usarse como original_url RENOVABLE para reconstruir el
 * enlace firmado o solicitar una sesión proxy. NUNCA debe ser el HLS firmado temporal.
 * Orden: canonical_locator > original_url > url.
 */
export function canonicalUrlOf(server: ScoredServer | null | undefined): string | undefined {
  if (!server) return undefined;
  return server.canonical_locator || server.original_url || server.url;
}

/**
 * Comprueba si una fuente expiró sin tener un origen o localizador renovable.
 * Regla 1: expired_without_locator jamás entra en trying_direct ni requesting_proxy.
 */
export function isExpiredWithoutLocator(
  server: ScoredServer | null | undefined,
  resolution?: Partial<PlaybackResolution>
): boolean {
  if (resolution?.failure_reason === 'expired_without_locator') return true;
  if (server?.failure_reason === 'expired_without_locator') return true;
  return false;
}

/**
 * Comprueba si una URL es una página canónica no resuelta (ej. fichas de LaMovie, CineCalidad, AnimeFLV, etc.)
 * que NO debe montarse directamente como iframe.
 */
export function isUnresolvedCanonical(url: string | null | undefined): boolean {
  if (!url) return false;
  const lower = String(url).toLowerCase();
  if (lower.includes('.m3u8') || lower.includes('.mp4')) return false;
  return (
    lower.includes('lamovie.org/') ||
    lower.includes('cinecalidad.am/') ||
    lower.includes('animeflv.net/ver/') ||
    lower.includes('animeflv.to/ver/') ||
    lower.includes('jkanime.net/ver/') ||
    lower.includes('tioanime.com/ver/') ||
    lower.includes('latanime.org/ver/') ||
    lower.includes('veranimes.net/ver/') ||
    lower.includes('tioplus.app/') ||
    lower.includes('tubepelis.com/') ||
    lower.includes('tvmaze.com/') ||
    lower.includes('hianimes.se/watch/') ||
    lower.includes('hianimes.se/details/')
  );
}

/**
 * Comprueba si un servidor califica como un embed real que legítimamente puede
 * reproducirse en un iframe (fallback controlado).
 */
export function isRealPlayableEmbed(server: ScoredServer | null | undefined): boolean {
  if (!server) return false;
  if (!server.isEmbed) return false;
  if (isExpiredWithoutLocator(server)) return false;
  if (server.notPlayable) return false;
  if (isUnresolvedCanonical(server.url)) return false;
  return true;
}

/**
 * Ordena candidatos para el primer intento sin perder el orden del backend
 * dentro de cada grupo. Los directos (incluido direct_trial/proxy_required)
 * se prueban antes que un embed; los embeds reales quedan como fallback y las
 * páginas canónicas/no reproducibles al final para que no bloqueen el arranque.
 */
export function prioritizeDirectCandidates(servers: ScoredServer[]): ScoredServer[] {
  const playbackRank = (server: ScoredServer): number => {
    if (server.notPlayable || isExpiredWithoutLocator(server)) return 2;
    if (!server.isEmbed) return 0;
    if (isRealPlayableEmbed(server)) return 1;
    return 2;
  };

  return servers
    .map((server, index) => ({ server, index, rank: playbackRank(server) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ server }) => server);
}

/**
 * Regla 3: Un fallo directo puede escalar a proxy únicamente si is_proxyable !== false.
 * Regla 1: expired_without_locator jamás entra en requesting_proxy.
 */
export function canEscalateToProxy(server: ScoredServer | null | undefined): boolean {
  if (!server) return false;
  if (server.isEmbed) return false;
  if (isExpiredWithoutLocator(server)) return false;
  if (server.is_proxyable === false) return false;
  return true;
}

/**
 * Aplica atómicamente el resultado de resolveEmbed() sobre un servidor conservando
 * SIEMPRE el localizador original y toda la metadata de resolución. Nunca se propaga
 * un stream resuelto a otros servidores: cada candidato conserva su propia identidad.
 */
export function applyResolution(
  server: ScoredServer,
  resolution: Partial<PlaybackResolution>
): ScoredServer {
  const mode = deliveryModeOf(resolution.delivery_mode);
  const resolvedUrl = (resolution.url || '').trim();
  const failureReason = resolution.failure_reason || server.failure_reason;
  const isExpired = failureReason === 'expired_without_locator';

  const metadata = {
    original_url: resolution.original_url || server.original_url || server.url,
    canonical_locator: resolution.canonical_locator || server.canonical_locator,
    resolution_id: resolution.resolution_id || server.resolution_id,
    generation: resolution.generation || server.generation,
    is_proxyable: resolution.is_proxyable ?? server.is_proxyable,
    is_refreshable: resolution.is_refreshable ?? server.is_refreshable,
    refresh_after: resolution.refresh_after ?? server.refresh_after,
    expires_at: resolution.expires_at ?? server.expires_at,
    resolved_at: resolution.resolved_at ?? server.resolved_at,
    failure_reason: failureReason,
    requiredHeaders: resolution.requiredHeaders || server.requiredHeaders,
    subtitles: resolution.subtitles || server.subtitles,
  };

  // Si la fuente expiró sin localizador, marcar como no reproducible y no avanzar a directo ni proxy.
  if (isExpired) {
    return {
      ...server,
      ...metadata,
      notPlayable: true,
      label: `[Expirado] ${server.provider}`,
    };
  }

  // No hay stream resuelto o resolución fallida: conservar el servidor intacto.
  if (resolution.resolved === false || !resolvedUrl || resolvedUrl === server.url) {
    return {
      ...server,
      delivery_mode: mode || server.delivery_mode,
      ...metadata,
    };
  }

  // Stream resuelto: si el resultado sigue siendo un embed, la URL se monta en
  // iframe aunque el candidato original fuese una página canónica. Esto evita
  // enviar una URL HTML a HLS.js como si fuese un manifiesto nativo.
  const wasEmbed = server.isEmbed;
  const resolvedIsEmbed = resolution.type === 'embed' || mode === 'embed';
  const resolvedMetadata = {
    ...metadata,
    original_url:
      resolution.original_url || server.original_url || (wasEmbed ? server.url : undefined),
  };

  // Si el resolve devuelve un tipo embed (no nativo), mantener el iframe con metadata.
  // También aplica a páginas canónicas que se resolvieron JIT a un embed real.
  if (resolvedIsEmbed) {
    return {
      ...server,
      url: resolvedUrl,
      isEmbed: true,
      streamType: 'embed',
      delivery_mode: mode || server.delivery_mode,
      notPlayable: false,
      ...resolvedMetadata,
    };
  }

  return {
    ...server,
    url: resolvedUrl,
    isEmbed: false,
    streamType: 'direct',
    delivery_mode: mode || server.delivery_mode || 'direct',
    label: `[Direct HD] ${resolution.provider || server.provider}`,
    ...resolvedMetadata,
  };
}

/**
 * Clave de reconexión: detecta cambios REALES del servidor activo. Una URL,
 * generación o modo de entrega nuevo debe reconectar HLS.js aunque siga siendo el mismo índice.
 * Regla 8: La clave de conexión debe incluir URL, generación y delivery mode.
 */
export function buildAttachmentKey(server: ScoredServer | null | undefined): string {
  if (!server) return '';
  return [server.id, server.url, server.generation || '', server.delivery_mode || ''].join('|');
}

/**
 * Firma estable de la lista de servidores: usa la identidad de carga y la
 * metadata que puede cambiar una resolución JIT (generación, modo, expiración,
 * localizador y estado reproducible). Así una URL renovada en el mismo índice
 * vuelve a conectar HLS.js, pero una recreación superficial del array no resetea
 * la selección del usuario.
 */
export function serversStableSignature(servers: ScoredServer[]): string {
  return servers
    .map((s) =>
      [
        s.id,
        s.url,
        s.original_url || '',
        s.canonical_locator || '',
        s.generation || '',
        s.delivery_mode || '',
        s.isEmbed ? 'embed' : 'direct',
        s.notPlayable ? 'blocked' : 'playable',
        s.refresh_after ?? '',
        s.expires_at ?? '',
      ].join('|')
    )
    .join('\u0001');
}

/**
 * Determina la URL de carga e intención de entrega.
 * Regla 1: expired_without_locator jamás entra en trying_direct ni requesting_proxy.
 * Regla 3: Un fallo directo puede escalar a proxy únicamente si is_proxyable !== false.
 */
export function nextDeliveryIntent(
  server: ScoredServer | null | undefined,
  capability: 'direct_ok' | 'proxy_required' | 'embed_only' | null
): 'direct' | 'proxy' | 'skip' {
  if (!server) return 'direct';
  if (isExpiredWithoutLocator(server)) return 'skip';
  if (server.isEmbed) return 'direct';
  if (server.delivery_mode === 'proxy_required' || capability === 'proxy_required') {
    if (canEscalateToProxy(server)) {
      return 'proxy';
    }
    return 'direct';
  }
  return 'direct';
}

/**
 * Confirma si un estado de entrega es "reproducción establecida" (cancelaría el
 * watchdog directo).
 */
export function isPlaybackEstablished(deliveryState: DeliveryState | string): boolean {
  return (
    deliveryState === 'playing_direct' ||
    deliveryState === 'playing_proxy' ||
    deliveryState === 'playing_embed'
  );
}

/**
 * Regla 9: La renovación preventiva solo se programa si existe refresh_after y is_refreshable=true.
 * Regla 10: Una sesión proxy no se recarga preventivamente desde el frontend; el backend administra su URL actual.
 */
export function shouldScheduleRenewal(
  server: ScoredServer | null | undefined,
  deliveryState: DeliveryState | string
): boolean {
  if (!server) return false;
  if (deliveryState === 'playing_proxy') return false; // Regla 10
  if (deliveryState !== 'playing_direct') return false;
  if (!server.refresh_after || server.refresh_after <= 0) return false;
  // Regla 9: solo si is_refreshable es true
  return server.is_refreshable === true;
}

/**
 * Actualiza la metadata de un servidor tras una renovación preventiva conservando
 * posición y demás campos. No propaga el stream a otros servidores.
 */
export function updateRenewedServer(
  server: ScoredServer,
  renewal: Partial<PlaybackResolution>
): ScoredServer {
  const url = (renewal.url || '').trim() || server.url;
  const wasEmbed = server.isEmbed;
  const urlChanged = url !== server.url;
  const looksNative = /\.m3u8|\.mp4|\/m3u8\//i.test(url);

  // Si el embed original seguía siéndolo y la renovación extrae un stream nativo,
  // degradar a directo conservando el embed original en original_url.
  const nextIsEmbed = wasEmbed && !looksNative;

  return {
    ...server,
    url,
    isEmbed: nextIsEmbed,
    streamType: nextIsEmbed ? 'embed' : 'direct',
    original_url:
      renewal.original_url || server.original_url || (urlChanged ? server.url : server.original_url),
    canonical_locator: renewal.canonical_locator || server.canonical_locator,
    resolution_id: renewal.resolution_id || server.resolution_id,
    generation: renewal.generation || server.generation,
    delivery_mode: deliveryModeOf(renewal.delivery_mode) || server.delivery_mode,
    is_proxyable: renewal.is_proxyable ?? server.is_proxyable,
    is_refreshable: renewal.is_refreshable ?? server.is_refreshable,
    refresh_after: renewal.refresh_after ?? server.refresh_after,
    expires_at: renewal.expires_at ?? server.expires_at,
    resolved_at: renewal.resolved_at ?? server.resolved_at,
    failure_reason: renewal.failure_reason ?? server.failure_reason,
    requiredHeaders: renewal.requiredHeaders || server.requiredHeaders,
  };
}

/**
 * Regla 6: Protección de intento actual contra callbacks/timers antiguos.
 */
export function isAttemptCurrent(currentAttemptId: number, callbackAttemptId: number): boolean {
  return currentAttemptId === callbackAttemptId;
}

/**
 * Regla 7: Un servidor no puede intentarse más de una vez por modo dentro del mismo intento de reproducción.
 */
export function hasAttemptedMode(
  attemptedSet: Set<string>,
  serverId: string,
  mode: DeliveryMode | 'direct' | 'proxy' | 'embed'
): boolean {
  return attemptedSet.has(`${serverId}:${mode}`);
}

export function recordAttemptedMode(
  attemptedSet: Set<string>,
  serverId: string,
  mode: DeliveryMode | 'direct' | 'proxy' | 'embed'
): void {
  attemptedSet.add(`${serverId}:${mode}`);
}

/**
 * Regla 5: Un iframe/embed no cambia automáticamente de servidor por timeout; ofrece elección manual.
 */
export function handleEmbedTimeout(_currentState: DeliveryState): DeliveryState {
  return 'awaiting_manual_choice';
}
