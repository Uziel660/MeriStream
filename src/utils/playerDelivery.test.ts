import { describe, it, expect } from 'vitest';
import type { ScoredServer } from './streamOptimizer';
import {
  applyResolution,
  buildAttachmentKey,
  canonicalUrlOf,
  serversStableSignature,
  updateRenewedServer,
  nextDeliveryIntent,
  isPlaybackEstablished,
  shouldScheduleRenewal,
  canEscalateToProxy,
  isExpiredWithoutLocator,
  isUnresolvedCanonical,
  isRealPlayableEmbed,
  prioritizeDirectCandidates,
  hasAttemptedMode,
  recordAttemptedMode,
  isAttemptCurrent,
  handleEmbedTimeout,
  DIRECT_WATCHDOG_MS,
  MAX_PROBE_CANDIDATES,
  MSG_EXPIRED_WITHOUT_LOCATOR,
  MSG_PROXY_FAILED,
  type DeliveryState,
} from './playerDelivery';

function makeServer(overrides: Partial<ScoredServer> = {}): ScoredServer {
  return {
    id: 'server-1',
    url: 'https://cdn.example/master.m3u8?st=abc&e=123',
    label: '[1080p] CDN',
    provider: 'CDN',
    quality: '1080p',
    isEmbed: false,
    streamType: 'direct',
    score: 80,
    health: 'excelente',
    ...overrides,
  };
}

describe('playerDelivery — 8 pruebas obligatorias', () => {
  it('1. Vencido sin locator salta directo y proxy', () => {
    // Servidor con failure_reason 'expired_without_locator'
    const expiredServer = makeServer({
      id: 'expired-1',
      failure_reason: 'expired_without_locator',
    });

    expect(isExpiredWithoutLocator(expiredServer)).toBe(true);
    expect(canEscalateToProxy(expiredServer)).toBe(false);
    expect(nextDeliveryIntent(expiredServer, 'direct_ok')).toBe('skip');
    expect(nextDeliveryIntent(expiredServer, 'proxy_required')).toBe('skip');

    // applyResolution con expired_without_locator marca notPlayable y conserva failure_reason
    const res = applyResolution(makeServer(), {
      resolved: false,
      failure_reason: 'expired_without_locator',
    });
    expect(res.notPlayable).toBe(true);
    expect(res.failure_reason).toBe('expired_without_locator');
    expect(isExpiredWithoutLocator(res)).toBe(true);
    expect(nextDeliveryIntent(res, null)).toBe('skip');
  });

  it('2. Vigente proxyable/no renovable permite proxy después de fallo directo', () => {
    const server = makeServer({
      is_proxyable: true,
      is_refreshable: false,
      delivery_mode: 'direct',
    });

    // Inicialmente intenta directo
    expect(nextDeliveryIntent(server, 'direct_ok')).toBe('direct');
    expect(canEscalateToProxy(server)).toBe(true);

    // Tras fallo directo (delivery_mode proxy_required o capability proxy_required), escala a proxy
    const proxyNeededServer = { ...server, delivery_mode: 'proxy_required' as const };
    expect(nextDeliveryIntent(proxyNeededServer, 'proxy_required')).toBe('proxy');

    // Al no ser renovable (is_refreshable: false), no programa renovación
    expect(shouldScheduleRenewal(server, 'playing_direct')).toBe(false);
  });

  it('3. Renovable programa renovación', () => {
    const renewableServer = makeServer({
      is_refreshable: true,
      refresh_after: Date.now() + 60000,
      delivery_mode: 'direct',
    });

    expect(shouldScheduleRenewal(renewableServer, 'playing_direct')).toBe(true);

    const renewed = updateRenewedServer(renewableServer, {
      url: 'https://cdn.example/renewed.m3u8',
      generation: 'gen-2',
      refresh_after: Date.now() + 120000,
    });
    expect(renewed.url).toBe('https://cdn.example/renewed.m3u8');
    expect(renewed.generation).toBe('gen-2');

    // Sin refresh_after no programa renovación
    const noDeadline = { ...renewableServer, refresh_after: undefined };
    expect(shouldScheduleRenewal(noDeadline, 'playing_direct')).toBe(false);

    // Con is_refreshable = false no programa renovación
    const nonRenewable = { ...renewableServer, is_refreshable: false };
    expect(shouldScheduleRenewal(nonRenewable, 'playing_direct')).toBe(false);
  });

  it('4. Proxy no renovable no programa renovación frontend', () => {
    const proxyServer = makeServer({
      delivery_mode: 'proxy_required',
      refresh_after: Date.now() + 60000,
      is_refreshable: true, // Aunque el origen sea renovable, el proxy es gestionado por backend
    });

    // En estado playing_proxy, la renovación preventiva en frontend NUNCA se programa (Regla 10)
    expect(shouldScheduleRenewal(proxyServer, 'playing_proxy')).toBe(false);

    const nonRefreshableProxy = { ...proxyServer, is_refreshable: false };
    expect(shouldScheduleRenewal(nonRefreshableProxy, 'playing_proxy')).toBe(false);
  });

  it('5. Callback tardío de un servidor anterior se ignora', () => {
    const currentAttemptId = 3;
    const staleCallbackAttemptId = 2;
    const activeCallbackAttemptId = 3;

    expect(isAttemptCurrent(currentAttemptId, staleCallbackAttemptId)).toBe(false);
    expect(isAttemptCurrent(currentAttemptId, activeCallbackAttemptId)).toBe(true);

    // Resolución de un servidor A no afecta al servidor B
    const serverA = makeServer({ id: 'srvA', url: 'https://a.example/master.m3u8' });
    const serverB = makeServer({ id: 'srvB', url: 'https://b.example/master.m3u8' });
    const resolvedA = applyResolution(serverA, { resolved: true, url: 'https://a.example/new.m3u8' });

    expect(resolvedA.id).toBe('srvA');
    expect(serverB.url).toBe('https://b.example/master.m3u8');
  });

  it('6. Misma URL con nueva generación se reconecta', () => {
    const s1 = makeServer({
      url: 'https://cdn.example/live.m3u8',
      generation: 'gen-1',
      delivery_mode: 'direct',
    });
    const s2 = makeServer({
      url: 'https://cdn.example/live.m3u8',
      generation: 'gen-2',
      delivery_mode: 'direct',
    });

    // Mismo ID y URL, pero diferente generación => clave distinta para forzar reconexión
    expect(buildAttachmentKey(s1)).not.toBe(buildAttachmentKey(s2));

    // Mismo ID, URL y generación pero cambia modo a proxy => clave distinta
    const s3 = makeServer({
      url: 'https://cdn.example/live.m3u8',
      generation: 'gen-1',
      delivery_mode: 'proxy_required',
    });
    expect(buildAttachmentKey(s1)).not.toBe(buildAttachmentKey(s3));

    // Clave idéntica si no hay cambios reales
    expect(buildAttachmentKey(s1)).toBe(buildAttachmentKey({ ...s1 }));
  });

  it('7. Timeout de iframe no produce failover automático', () => {
    const embedState: DeliveryState = 'playing_embed';
    const nextState = handleEmbedTimeout(embedState);

    // El timeout de embed pasa a awaiting_manual_choice, NO a cambio automático ni error directo
    expect(nextState).toBe('awaiting_manual_choice');
    expect(nextState).not.toBe('error');
    expect(nextState).not.toBe('trying_direct');
  });

  it('8. Ningún servidor repite el mismo modo en un intento', () => {
    const attempted = new Set<string>();

    expect(hasAttemptedMode(attempted, 'srv-1', 'direct')).toBe(false);
    recordAttemptedMode(attempted, 'srv-1', 'direct');
    expect(hasAttemptedMode(attempted, 'srv-1', 'direct')).toBe(true);

    // Otro modo en el mismo servidor aún no ha sido intentado
    expect(hasAttemptedMode(attempted, 'srv-1', 'proxy')).toBe(false);
    recordAttemptedMode(attempted, 'srv-1', 'proxy');
    expect(hasAttemptedMode(attempted, 'srv-1', 'proxy')).toBe(true);

    // Otro servidor no se ve afectado
    expect(hasAttemptedMode(attempted, 'srv-2', 'direct')).toBe(false);
  });
});

describe('playerDelivery — helpers adicionales y estabilidad', () => {
  it('canonicalUrlOf usa canonical_locator > original_url > url', () => {
    const server = makeServer({
      url: 'https://cdn.example/signed.m3u8?st=temp',
      original_url: 'https://edge.example/src.m3u8',
      canonical_locator: 'https://edge.example/canonical.m3u8',
    });
    expect(canonicalUrlOf(server)).toBe('https://edge.example/canonical.m3u8');

    const noCanonical = makeServer({
      url: 'https://cdn.example/signed.m3u8?st=temp',
      original_url: 'https://edge.example/src.m3u8',
    });
    expect(canonicalUrlOf(noCanonical)).toBe('https://edge.example/src.m3u8');

    const bare = makeServer({ url: 'https://cdn.example/bare.m3u8' });
    expect(canonicalUrlOf(bare)).toBe('https://cdn.example/bare.m3u8');
    expect(canonicalUrlOf(null)).toBeUndefined();
  });

  it('serversStableSignature mantiene estabilidad frente a recreación de arrays', () => {
    const list1 = [
      makeServer({ id: 'a', url: 'https://cdn.example/a.m3u8' }),
      makeServer({ id: 'b', url: 'https://cdn.example/b.m3u8' }),
    ];
    const list2 = [
      makeServer({ id: 'a', url: 'https://cdn.example/a.m3u8' }),
      makeServer({ id: 'b', url: 'https://cdn.example/b.m3u8' }),
    ];
    expect(serversStableSignature(list1)).toBe(serversStableSignature(list2));
  });

  it('isPlaybackEstablished identifica estados de reproducción confirmada', () => {
    expect(isPlaybackEstablished('playing_direct')).toBe(true);
    expect(isPlaybackEstablished('playing_proxy')).toBe(true);
    expect(isPlaybackEstablished('playing_embed')).toBe(true);
    expect(isPlaybackEstablished('trying_direct')).toBe(false);
    expect(isPlaybackEstablished('requesting_proxy')).toBe(false);
    expect(isPlaybackEstablished('resolving')).toBe(false);
    expect(isPlaybackEstablished('error')).toBe(false);
  });

  it('constantes de tiempo y mensajes cumplen límites mínimos', () => {
    expect(DIRECT_WATCHDOG_MS).toBeGreaterThanOrEqual(5000);
    expect(MAX_PROBE_CANDIDATES).toBeLessThanOrEqual(4);
    expect(MSG_EXPIRED_WITHOUT_LOCATOR).toBe('Esta fuente antigua necesita reimportarse.');
    expect(MSG_PROXY_FAILED).toBe('No se pudo usar el proxy. Puedes probar otro servidor.');
  });

  it('isUnresolvedCanonical detecta páginas de catálogo que no deben montarse en iframe', () => {
    expect(isUnresolvedCanonical('https://lamovie.org/peliculas/10-cosas')).toBe(true);
    expect(isUnresolvedCanonical('https://cinecalidad.am/pelicula/ejemplo.html')).toBe(true);
    expect(isUnresolvedCanonical('https://animeflv.net/ver/anime-1')).toBe(true);
    expect(isUnresolvedCanonical('https://tioanime.com/ver/anime-2')).toBe(true);
    expect(isUnresolvedCanonical('https://hianimes.se/watch/anime-episode-1')).toBe(true);
    expect(isUnresolvedCanonical('https://streamtape.com/e/abc123xyz')).toBe(false);
    expect(isUnresolvedCanonical('https://edge.cdn.com/master.m3u8')).toBe(false);
  });

  it('isRealPlayableEmbed valida embeds reales y rechaza páginas no resueltas o expiradas', () => {
    const realEmbed = makeServer({
      isEmbed: true,
      url: 'https://streamtape.com/e/abc123xyz',
    });
    expect(isRealPlayableEmbed(realEmbed)).toBe(true);

    const unresolvedPage = makeServer({
      isEmbed: true,
      url: 'https://lamovie.org/peliculas/10-cosas',
    });
    expect(isRealPlayableEmbed(unresolvedPage)).toBe(false);

    const expiredEmbed = makeServer({
      isEmbed: true,
      url: 'https://streamtape.com/e/abc123xyz',
      failure_reason: 'expired_without_locator',
    });
    expect(isRealPlayableEmbed(expiredEmbed)).toBe(false);

    const directStream = makeServer({
      isEmbed: false,
      url: 'https://edge.cdn.com/master.m3u8',
    });
    expect(isRealPlayableEmbed(directStream)).toBe(false);
  });

  it('prioriza directos sobre embeds preservando el orden relativo', () => {
    const embed = makeServer({
      id: 'embed',
      url: 'https://vidhideplus.com/v/abc123',
      isEmbed: true,
      streamType: 'embed',
    });
    const directTrial = makeServer({
      id: 'direct-trial',
      url: 'https://cdn.example/trial.m3u8',
      delivery_mode: 'direct_trial',
    });
    const direct = makeServer({
      id: 'direct',
      url: 'https://cdn.example/direct.m3u8',
      delivery_mode: 'direct',
    });

    expect(prioritizeDirectCandidates([embed, directTrial, direct]).map((s) => s.id))
      .toEqual(['direct-trial', 'direct', 'embed']);
  });

  it('deja al final páginas canónicas no reproducibles', () => {
    const unresolved = makeServer({
      id: 'page',
      url: 'https://tioanime.com/ver/show-1',
      isEmbed: true,
      streamType: 'embed',
      notPlayable: true,
    });
    const embed = makeServer({
      id: 'embed',
      url: 'https://vidhideplus.com/v/abc123',
      isEmbed: true,
      streamType: 'embed',
    });
    expect(prioritizeDirectCandidates([unresolved, embed]).map((s) => s.id))
      .toEqual(['embed', 'page']);
  });

  it('canonicalUrlOf garantiza que la solicitud proxy use canonical_locator preferentemente', () => {
    const serverWithLocator = makeServer({
      url: 'https://cdn-edge.net/hls/master.m3u8?st=signed123',
      original_url: 'https://origin.com/stream.m3u8',
      canonical_locator: 'https://upstream-provider.com/embed/ref-999',
    });
    expect(canonicalUrlOf(serverWithLocator)).toBe('https://upstream-provider.com/embed/ref-999');
  });

  it('una página canónica resuelta a embed se monta como iframe, no como HLS', () => {
    const canonicalPage = makeServer({
      id: 'canonical-page',
      url: 'https://tioanime.com/ver/yozakurasan-chi-no-daisakusen-1',
      isEmbed: false,
      streamType: 'direct',
      notPlayable: true,
      canonical_locator: 'https://tioanime.com/ver/yozakurasan-chi-no-daisakusen-1',
    });

    const resolved = applyResolution(canonicalPage, {
      resolved: true,
      url: 'https://ok.ru/videoembed/123456',
      type: 'embed',
      delivery_mode: 'embed',
      original_url: canonicalPage.url,
      canonical_locator: canonicalPage.url,
    });

    expect(resolved.url).toBe('https://ok.ru/videoembed/123456');
    expect(resolved.isEmbed).toBe(true);
    expect(resolved.streamType).toBe('embed');
    expect(resolved.delivery_mode).toBe('embed');
    expect(resolved.notPlayable).toBe(false);
  });
});
