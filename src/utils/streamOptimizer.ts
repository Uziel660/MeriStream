import { proxiedStreamUrl } from './proxiedUrl';
import type { RankedStream } from '../types';

export type DeliveryMode = 'direct' | 'direct_trial' | 'proxy_required' | 'embed';

export interface ExtendedRankedStream extends RankedStream {
  original_url?: string;
  canonical_locator?: string;
  resolution_id?: string;
  generation?: string;
  delivery_mode?: DeliveryMode;
  is_proxyable?: boolean;
  is_refreshable?: boolean;
  refresh_after?: number;
  expires_at?: number;
  resolved_at?: number;
  failure_reason?:
    | 'expired_without_locator'
    | 'unresolved'
    | 'unsafe_url'
    | 'empty_locator'
    | 'provider_blocked'
    | 'drm_or_captcha';
  requiredHeaders?: Record<string, string>;
}

export interface ScoredServer {
  id: string;
  url: string;
  label: string;
  provider: string;
  quality: '4K' | '1080p' | '720p' | '480p' | 'Auto HD';
  isEmbed: boolean;
  streamType: 'direct' | 'embed';
  score: number;
  health: 'excelente' | 'buena' | 'estable' | 'desconocida';
  /** true = página web cruda o placeholder sin contenido; la UI debe deshabilitar su selección. */
  notPlayable?: boolean;
  latencyMs?: number;
  /** Tier del backend (1-4); presente cuando la respuesta trae ranked_streams. */
  tier?: number;
  /** Plataforma de origen (animeflv, cinecalidad, latanime...); presente con ranked_streams. */
  sourceSite?: string;
  /** URL original sin firmar/renovable tal y como llegó del backend. */
  original_url?: string;
  /** Localizador canónico estable (preferido para renovar/re-resolver y proxy). */
  canonical_locator?: string;
  /** ID de resolución que el backend empareja con original_url para sesiones proxy. */
  resolution_id?: string;
  /** Generación de la resolución actual; cambia al renovar el enlace firmado. */
  generation?: string;
  delivery_mode?: DeliveryMode;
  is_proxyable?: boolean;
  is_refreshable?: boolean;
  refresh_after?: number;
  expires_at?: number;
  resolved_at?: number;
  failure_reason?:
    | 'expired_without_locator'
    | 'unresolved'
    | 'unsafe_url'
    | 'empty_locator'
    | 'provider_blocked'
    | 'drm_or_captcha';
  /** Cabeceras que el CDN exige al consumir url (el proxy las inyecta server-side). */
  requiredHeaders?: Record<string, string>;
  /** Rendition metadata used by the language selector (sub/dub or audio code). */
  link_type?: string;
  language?: string;
  audio_language?: string;
  subtitle_language?: string;
  subtitle_mode?: 'external' | 'burned_in' | 'unknown';
  subtitles?: Array<{ id?: string; label?: string; language?: string; url?: string; src?: string; is_default?: boolean }>;
}

/**
 * Estos HLS/MP4 guardados en BD expiran antes del play (defecto #11: 403 al
 * abrir horas después); si fallan conviene re-resolver Just-In-Time.
 */
export function hasExpiringSignature(url: string | null | undefined): boolean {
  if (!url) return false;
  const lower = String(url).toLowerCase();
  if (!/\.m3u8|\.mp4/.test(lower)) return false;
  // CDNs públicos estables: sus query params no son firmas de expiración
  if (
    lower.includes('googleapis.com') ||
    lower.includes('mux.dev') ||
    lower.includes('archive.org')
  ) {
    return false;
  }
  try {
    const q = new URL(String(url)).searchParams;
    return ['st', 's', 'e', 't', 'sig', 'signature', 'token', 'expires', 'h'].some((k) =>
      q.has(k)
    );
  } catch {
    return false;
  }
}

/**
 * Detecta páginas web crudas (fichas de episodio tipo /ver/<slug>-<n>, fichas de
 * película, listados): NO son medios reproducibles y un fetch directo desde el
 * navegador muere por CORS. Deben resolverse Just-In-Time vía
 * /api/v1/catalog/episode-servers o /resolve-embed antes de dar play.
 */
export function isRawWebpageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const lower = String(url).toLowerCase();

  // Páginas de detalle de TVMaze (API de metadatos: nunca contienen video)
  if (/tvmaze\.com\/(shows|episodes)\//.test(lower)) return true;

  // Fichas de episodio/película con patrón /ver/ o equivalentes conocidos
  return (
    (lower.includes('lamovie.org/peliculas/') ||
      lower.includes('lamovie.org/series/') ||
      lower.includes('lamovie.org/animes/') ||
      lower.includes('animeflv.net/ver/') ||
      lower.includes('animeflv.to/ver/') ||
      lower.includes('jkanime.net/') ||
      lower.includes('tioanime.com/ver/') ||
      lower.includes('latanime.org/ver/') ||
      lower.includes('wwv.veranimes.net/ver/') ||
      lower.includes('veranimes.net/ver/') ||
      lower.includes('tioplus.app/') ||
      lower.includes('tubepelis.com/pelicula/') ||
      lower.includes('cinecalidad.') ||
      lower.includes('hianimes.se/') ||
      lower.includes('doramasflix.') ||
      lower.includes('gnulahd.nu/')) &&
    !lower.includes('.m3u8') &&
    !lower.includes('.mpd') &&
    !lower.includes('.mp4')
  );
}

/**
 * Detecta si una URL es un locator de proveedor o un recurso para el motor nativo.
 */
export function isEmbedUrl(url: string): boolean {
  if (!url) return false;
  const u = url.toLowerCase();

  // Stream nativo servido por nuestro backend (descifrado Mega on-the-fly): siempre directo
  if (u.includes('/api/v1/stream/mega')) return false;
  if (u.includes('/m3u8/') || u.includes('hls-vod')) return false;

  // Direct media files (.m3u8, .mpd, .mp4, .webm, .mkv) are played natively.
  // Extension regex (not substring): evita que ".mp4upload.com" haga match de ".mp4".
  if (
    (/\.(m3u8|mpd|mp4|webm|mkv)(\?|#|$)/.test(u)) &&
    !u.includes('mega.nz') &&
    !u.includes('/embed') &&
    !u.includes('/e/')
  ) {
    return false;
  }

  return (
    u.includes('zokoanime') ||
    u.includes('megaplay') ||
    u.includes('player.zilla-networks.com') ||
    u.includes('/embed') ||
    u.includes('/e/') ||
    u.includes('voe.') ||
    u.includes('voe.sx') ||
    u.includes('mega.nz') ||
    u.includes('mp4upload.com') ||
    u.includes('streamtape.com') ||
    u.includes('byselapuix.com') ||
    u.includes('ok.ru/videoembed') ||
    u.includes('streamwish') ||
    u.includes('filemoon') ||
    u.includes('yourupload.com') ||
    u.includes('vidmoly') ||
    u.includes('dood') ||
    u.includes('fembed') ||
    u.includes('mixdrop') ||
    u.includes('uqload') ||
    u.includes('upstream') ||
    u.includes('embedsito') ||
    u.includes('streamlare') ||
    u.includes('fastre')
  );
}

/**
 * Extrae la calidad estimada a partir de la URL o nombres de archivo
 */
export function detectQualityFromUrl(url: string): '4K' | '1080p' | '720p' | '480p' | 'Auto HD' {
  const u = url.toLowerCase();
  if (u.includes('4k') || u.includes('2160p')) return '4K';
  if (u.includes('1080p') || u.includes('fullhd') || u.includes('fhd')) return '1080p';
  if (u.includes('720p') || u.includes('hd')) return '720p';
  if (u.includes('480p') || u.includes('sd')) return '480p';
  if (u.includes('.m3u8') || u.includes('mux.dev')) return 'Auto HD';
  return '1080p';
}

/**
 * Obtiene el nombre del proveedor amigable y legible
 */
export function getProviderName(url: string, index: number, sourceSite?: string, host?: string | null): string {
  if (host && typeof host === 'string' && host.trim()) {
    const cleanHost = host.trim().replace(/^www\./i, '');
    const tokens = cleanHost.split('.').filter(Boolean);
    const hostLabel = tokens.length >= 2 ? tokens[tokens.length - 2] : cleanHost;
    const capitalizedHost = hostLabel.charAt(0).toUpperCase() + hostLabel.slice(1);
    if (sourceSite && typeof sourceSite === 'string' && sourceSite.trim()) {
      const site = sourceSite.trim().toUpperCase();
      return `${capitalizedHost} (${site})`;
    }
    return capitalizedHost;
  }

  const u = (url || '').toLowerCase();
  if (u.includes('zokoanime')) return 'ZokoAnime (Embed)';
  if (u.includes('megaplay')) return 'AniPulse / Megaplay (HLS)';
  if (u.includes('/api/v1/stream/mega')) return 'Mega Directo (Nativo)';
  if (u.includes('mux.dev') || u.includes('test-streams')) return 'CDN Ultra HLS (Rápido)';
  if (u.includes('commondatastorage.googleapis.com') || u.includes('storage.googleapis')) return 'Google Fast Direct';
  if (u.includes('zilla-networks')) return 'Zilla HLS Network';
  if (u.includes('voe.sx') || u.includes('voe.') || u.includes('byselapuix')) return 'VOE HighSpeed';
  if (u.includes('premilkyway') || u.includes('wishonly') || u.includes('sfastwish') || u.includes('streamwish') || u.includes('flaswish')) return 'StreamWish';
  if (u.includes('filemoon')) return 'Filemoon HD';
  if (u.includes('playmudos') || u.includes('yourupload')) return 'YourUpload';
  if (u.includes('streamtape')) return 'Streamtape CDN';
  if (u.includes('mega.nz')) return 'Mega Cloud';
  if (u.includes('mp4upload.com/embed') || /mp4upload\.com\/[a-z0-9]+$/.test(u)) return 'MP4Upload (Embed)';
  if (u.includes('mp4upload')) return 'MP4Upload HD';
  if (u.includes('vidmoly')) return 'Vidmoly Fast';
  if (u.includes('dood')) return 'Doodstream';
  if (u.includes('fembed')) return 'Fembed HD';
  if (u.includes('mixdrop')) return 'Mixdrop';
  if (u.includes('uqload')) return 'Uqload Fast';
  if (u.includes('dramiyos-cdn') || u.includes('vidhide') || u.includes('vixhide')) return 'Vidhide';
  if (u.includes('vimeos')) return 'Vimeos';
  if (u.includes('goodstream')) return 'Goodstream';
  if (u.includes('animeflv')) return 'AnimeFLV';
  if (u.includes('jkanime')) return 'JKanime';
  if (u.includes('tioanime')) return 'TioAnime';
  if (u.includes('latanime')) return 'LatAnime';
  if (u.includes('cinecalidad')) return 'Cinecalidad';
  if (u.includes('lamovie')) return 'LaMovie';

  if (sourceSite && typeof sourceSite === 'string' && sourceSite.trim()) {
    const site = sourceSite.trim().toUpperCase();
    if (u.endsWith('.m3u8') || u.includes('/m3u8/')) return `HLS (${site})`;
    if (u.endsWith('.mp4')) return `MP4 (${site})`;
    return `Servidor (${site})`;
  }

  if (u.endsWith('.m3u8') || u.includes('/m3u8/')) return `HLS Master ${index + 1}`;
  if (u.endsWith('.mp4')) return `Direct MP4 ${index + 1}`;
  return `Servidor ${index + 1}`;
}

/**
 * Evalúa y califica un servidor multimedia para ordenar por máxima calidad y mejor salud
 */
export function scoreServer(rawUrl: string, index: number, metadataOverrides?: Partial<ScoredServer>): ScoredServer {
  let url = (rawUrl || '').trim();
  const provider = metadataOverrides?.provider || getProviderName(url, index, metadataOverrides?.sourceSite);

  // Página web cruda (ej. tvmaze.com/episodes/..., animeflv.net/ver/...): no es un
  // medio reproducible y un fetch directo desde el navegador muere por CORS.
  // Se marca notPlayable para que la UI la etiquete como "No reproducible".
  if (isRawWebpageUrl(url)) {
    return {
      id: `server-${index}-rawpage`,
      url,
      label: `No reproducible • ${provider}`,
      provider,
      quality: '480p',
      isEmbed: false,
      streamType: 'direct',
      notPlayable: true,
      score: -1000,
      health: 'desconocida',
      ...metadataOverrides,
    };
  }

  // Mega.nz: enrutar por nuestro backend de descifrado on-the-fly (stream nativo Plyr)
  // en vez de abrir la página del proveedor. El reproductor resuelve el locator
  // bajo demanda y continúa al siguiente candidato si no hay media nativa.
  // RUTA RELATIVA: funciona en local y a través del túnel de Cloudflare (mismo origen).
  const megaMatch = /^https?:\/\/(www\.)?(mega\.nz|mega\.io|mega\.co\.nz)\/(file|embed)\/([A-Za-z0-9_-]+)#(.+)$/i.exec(url);
  if (megaMatch) {
    url = `/api/v1/stream/mega?url=${encodeURIComponent(`https://mega.nz/file/${megaMatch[4]}#${megaMatch[5]}`)}`;
  } else if (url.includes('mega.nz/file/')) {
    // Sin clave (#KEY) no hay descifrado posible: mantener conversión legacy a /embed/
    url = url.replace('mega.nz/file/', 'mega.nz/embed/');
  }

  // Placeholder del host (ej. VOE sirve Big Buck Bunny cuando el archivo cayó): invalidar
  // Big Buck Bunny / demo / sample NUNCA es video real (orden del dueño): se marca no reproducible.
  // demo/sample se detecta solo como segmento de ruta/nombre de archivo delimitado, no como substring arbitrario
  const u0 = url.toLowerCase();
  let pathname = '';
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    // Fallback para URLs relativas o malformadas: extrae hasta ?/#
    const clean = String(url).toLowerCase().split('?')[0].split('#')[0];
    const m = clean.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)$/);
    pathname = m ? m[1] : clean.startsWith('/') ? clean : `/${clean}`;
  }
  const isDemoOrSampleSegment =
    /\/demo(\/|$|\.|\-|_)/.test(pathname) || /\/sample(\/|$|\.|\-|_)/.test(pathname);
  const isPlaceholder =
    u0.includes('big_buck_bunny') ||
    u0.includes('big-buck-bunny') ||
    u0.includes('bigbuckbunny') ||
    isDemoOrSampleSegment ||
    pathname.endsWith('_5mb.mp4');
  if (isPlaceholder) {
    return {
      id: `server-${index}-placeholder`,
      url,
      label: `No reproducible • ${provider}`,
      provider,
      quality: '480p',
      isEmbed: false,
      streamType: 'direct',
      notPlayable: true,
      score: -1000,
      health: 'desconocida',
      ...metadataOverrides,
    };
  }

  const isEmbed = isEmbedUrl(url);
  const streamType = isEmbed ? 'embed' : 'direct';
  const quality = detectQualityFromUrl(url);
  const u = url.toLowerCase();

  let score = 50; // base

  // 1. Prioridad por Calidad
  if (quality === '4K') score += 50;
  else if (quality === '1080p') score += 40;
  else if (quality === 'Auto HD') score += 38;
  else if (quality === '720p') score += 25;
  else if (quality === '480p') score += 10;

  // 2. Prioridad por Tipo de Entrega (HLS Nativo / Direct CDN > Embeds con publicidad)
  if (u.includes('.m3u8')) score += 25; // HLS nativo adaptativo de alta fidelidad
  if (u.includes('commondatastorage.googleapis.com') || u.includes('mux.dev')) score += 20; // Google / Mux ultra confiable
  if (u.includes('/api/v1/stream/mega')) score += 18; // Mega nativo: control total + sin ads
  if (!isEmbed) score += 15; // Reproductor nativo siempre brinda mejor experiencia

  // 3. Calificación de Salud y Estabilidad Heurística
  let health: ScoredServer['health'] = 'excelente';
  if (u.includes('zilla-networks')) {
    // El perfil público del CDN permite la entrega cuando se envían sus
    // cabeceras documentadas; no se usan clientes de huella ni bypass TLS.
    score += 15;
    health = 'excelente';
  } else if (u.includes('zokoanime')) {
    health = 'excelente';
    score += 22;
  } else if (isEmbed) {
    if (u.includes('voe.sx') || u.includes('byselapuix')) {
      health = 'buena';
      score += 10;
    } else if (u.includes('mega.nz')) {
      // Locator legacy de Mega sin clave: queda fuera del playback nativo.
      health = 'buena';
      score += 8;
    } else {
      health = 'estable';
    }
  } else if (u.includes('/api/v1/stream/mega')) {
    // Cuota anónima de Mega puede agotarse; el reproductor activa failover nativo.
    health = 'buena';
  }

  const label = `[${quality}] ${provider}`;

  return {
    id: `server-${index}-${Math.abs(hashString(url))}`,
    url,
    label,
    provider,
    quality,
    isEmbed,
    streamType,
    score,
    health,
    ...metadataOverrides,
  };
}

/**
 * Convierte directamente un RankedStream del backend a ScoredServer preservando
 * toda su metadata de entrega (canonical_locator, resolution_id, delivery_mode,
 * is_proxyable, is_refreshable, refresh_after, expires_at, failure_reason, etc.).
 */
export function scoredServerFromRanked(ranked: ExtendedRankedStream | RankedStream, index: number): ScoredServer {
  const isRaw = isRawWebpageUrl(ranked.url);
  const provider = getProviderName(ranked.url, index, ranked.source_site, ranked.host);
  const ext = ranked as ExtendedRankedStream;
  const isExpired = ext.failure_reason === 'expired_without_locator';

  const base = scoreServer(ranked.url, index, {
    provider,
    tier: ranked.tier,
    sourceSite: ranked.source_site,
    canonical_locator: ext.canonical_locator,
    resolution_id: ext.resolution_id,
    delivery_mode: ext.delivery_mode,
    is_proxyable: ext.is_proxyable,
    is_refreshable: ext.is_refreshable,
    refresh_after: ext.refresh_after,
    expires_at: ext.expires_at,
    resolved_at: ext.resolved_at,
    failure_reason: ext.failure_reason,
    generation: ext.generation,
    requiredHeaders: ext.requiredHeaders,
    link_type: ext.link_type,
    language: ext.language,
    audio_language: ext.audio_language,
    subtitle_language: ext.subtitle_language,
    subtitle_mode: ext.subtitle_mode,
    subtitles: ext.subtitles,
    original_url: ext.original_url || ranked.url,
  });

  if (isExpired) {
    return {
      ...base,
      notPlayable: true,
      label: `[Expirado] ${provider}`,
      score: -1000,
    };
  }

  if (isRaw) {
    const isJitRefreshable = Boolean(ext.canonical_locator || ext.is_refreshable);
    if (isJitRefreshable) {
      return {
        ...base,
        isEmbed: false,
        streamType: 'direct',
        notPlayable: false,
        label: provider,
        score: 40,
      };
    }
    return {
      ...base,
      isEmbed: false,
      streamType: 'direct',
      notPlayable: true,
      label: `No reproducible • ${provider}`,
      score: -1000,
    };
  }

  if (ranked.type === 'embed') {
    return {
      ...base,
      isEmbed: true,
      streamType: 'embed',
      delivery_mode: base.delivery_mode || 'embed',
    };
  } else if (ranked.type === 'direct') {
    return {
      ...base,
      isEmbed: false,
      streamType: 'direct',
    };
  }

  return base;
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

/**
 * Hosts DESCARTADOS por completo como servidores (petición del dueño, 2026-08-24):
 * VOE y Mixdrop no interesan por ahora. Espejo client-side de la lista negra del
 * backend (server/utils/streamSorter.ts) para que ni all_available_streams crudo
 * ni re-resolves JIT los cuelen en la UI.
 */
const CLIENT_BLACKLISTED_HOST_TOKENS = ['voe', 'mixdrop', 'mxdrop', 'filemoon'];

function isClientBlacklisted(url: string): boolean {
  const lower = String(url || '').toLowerCase();
  return CLIENT_BLACKLISTED_HOST_TOKENS.some((t) => lower.includes(t));
}

/**
 * Ordena servidores de mayor a menor calidad y salud, eliminando duplicados.
 */
export function rankAndSortServers(urls: string[]): ScoredServer[] {
  const uniqueUrls = Array.from(new Set(urls.filter((u) => Boolean(u && typeof u === 'string'))))
    // Descarte total de hosts vetados (voe/mixdrop/filemoon): ni aparecen.
    .filter((u) => !isClientBlacklisted(u));

  // Si hay streams reales (.m3u8, .mp4 o embeds), descartar URLs crudas de la página web
  const hasRealStreams = uniqueUrls.some((u) => !isRawWebpageUrl(u));
  const filteredUrls = hasRealStreams ? uniqueUrls.filter((u) => !isRawWebpageUrl(u)) : uniqueUrls;

  const deduplicatedUrlsMap = new Map<string, string>();
  // Clave de desduplicación para Mega: /file/ y /embed/ del mismo ID#KEY son el mismo recurso
  const megaKeyOf = (s: string): string | null => {
    const m = /^https?:\/\/(www\.)?(mega\.nz|mega\.io|mega\.co\.nz)\/(file|embed)\/([A-Za-z0-9_-]+)#(.+)$/i.exec(s.trim());
    return m ? `mega:${m[4].toLowerCase()}#${m[5]}` : null;
  };

  for (const raw of filteredUrls) {
    const megaKey = megaKeyOf(raw);
    if (megaKey) {
      if (!deduplicatedUrlsMap.has(megaKey)) {
        deduplicatedUrlsMap.set(megaKey, raw);
      }
      continue;
    }
    let u = raw;

    try {
      const urlObj = new URL(u);
      // Extraer base URL sin query parameters y trailing slashes para prevenir duplicados
      const normalized = urlObj.origin + urlObj.pathname.replace(/\/$/, '');
      if (!deduplicatedUrlsMap.has(normalized)) {
        deduplicatedUrlsMap.set(normalized, u);
      }
    } catch {
      const normalized = u.replace(/\/$/, '').split('?')[0];
      if (!deduplicatedUrlsMap.has(normalized)) {
        deduplicatedUrlsMap.set(normalized, u);
      }
    }
  }

  const deduplicatedUrls = Array.from(deduplicatedUrlsMap.values());
  const scored = deduplicatedUrls.map((url, idx) => scoreServer(url, idx));
  // Filtrar placeholders/demo/sample (Big Buck Bunny, /sample/, demo, _5mb.mp4): nunca son
  // video real y no deben aparecer como opción válida. Solo se descartan los
  // placeholders; las páginas crudas (rawpage) se conservan cuando son la única opción.
  const playable = scored.filter((s) => !(s.notPlayable && s.id.includes('placeholder')));

  // Ordenar descendentemente por puntuación (máxima calidad + salud primero)
  return playable.sort((a, b) => b.score - a.score);
}

/**
 * Aplica el tier del backend (jerarquía única en streamSorter del server) sobre
 * los servidores ya rankeados: el orden backend manda; el score heurístico solo
 * desempata dentro del mismo tier. Respuestas sin tier quedan intactas.
 */
/**
 * Aplica el ORDEN del backend (jerarquía streamSorter + prioridades manuales
 * de servidor por plataforma + SiteRating) sobre los servidores ya rankeados.
 * El orden del backend MANDA: los servidores que él ordenó conservan su
 * posición exacta; los que el backend no conoce se añaden al final por score.
 * Además, conserva TODA la metadata de entrega provista en ranked_streams:
 * canonical_locator, resolution_id, delivery_mode, is_proxyable, is_refreshable, etc.
 */
export function applyBackendTiers(servers: ScoredServer[], ranked: (ExtendedRankedStream | RankedStream)[] | undefined): ScoredServer[] {
  if (!ranked || ranked.length === 0) return servers;
  const metaByUrl = new Map(ranked.map((r) => [r.url, r]));
  const enriched = servers.map((s) => {
    const rawM = metaByUrl.get(s.url);
    if (!rawM) return s;
    const m = rawM as ExtendedRankedStream;
    const provider = getProviderName(s.url, 0, m.source_site ?? s.sourceSite, m.host);
    const isExpired = m.failure_reason === 'expired_without_locator' || s.failure_reason === 'expired_without_locator';
    const isRaw = isRawWebpageUrl(s.url);
    const backendProvided = Boolean(m.host || m.source_site);
    const isGenericProvider = !s.provider || s.provider.startsWith('Servidor') || s.provider.startsWith('HLS Master') || s.provider.startsWith('Direct MP4');
    const finalProvider = backendProvided || isGenericProvider ? provider : s.provider;

    const isJitRefreshable = Boolean(m.canonical_locator || s.canonical_locator || m.is_refreshable || s.is_refreshable);
    const label = isExpired
      ? `[Expirado] ${finalProvider}`
      : isRaw && !isJitRefreshable
      ? `No reproducible • ${finalProvider}`
      : s.label.includes('Servidor') || s.label.includes('HLS Master') || s.label.includes('Direct MP4')
      ? `[${s.quality}] ${finalProvider}`
      : s.label;

    return {
      ...s,
      provider: finalProvider,
      label,
      tier: m.tier,
      sourceSite: m.source_site ?? s.sourceSite,
      canonical_locator: m.canonical_locator ?? s.canonical_locator,
      resolution_id: m.resolution_id ?? s.resolution_id,
      delivery_mode: m.delivery_mode ?? s.delivery_mode,
      is_proxyable: m.is_proxyable ?? s.is_proxyable,
      is_refreshable: m.is_refreshable ?? s.is_refreshable,
      refresh_after: m.refresh_after ?? s.refresh_after,
      expires_at: m.expires_at ?? s.expires_at,
      resolved_at: m.resolved_at ?? s.resolved_at,
      failure_reason: m.failure_reason ?? s.failure_reason,
      generation: m.generation ?? s.generation,
      requiredHeaders: m.requiredHeaders ?? s.requiredHeaders,
      original_url: m.original_url ?? s.original_url,
      link_type: m.link_type ?? s.link_type,
      language: m.language ?? s.language,
      audio_language: m.audio_language ?? s.audio_language,
      subtitle_language: m.subtitle_language ?? s.subtitle_language,
      subtitle_mode: m.subtitle_mode ?? s.subtitle_mode,
      subtitles: m.subtitles ?? s.subtitles,
      ...(isExpired ? { notPlayable: true, score: -1000 } : {}),
      ...(isRaw
        ? {
            isEmbed: false,
            streamType: 'direct' as const,
            notPlayable: !isJitRefreshable,
            score: isJitRefreshable ? (s.score > 0 ? s.score : 40) : -1000,
          }
        : {}),
    };
  });
  const byUrl = new Map(enriched.map((s) => [s.url, s]));
  const ordered: ScoredServer[] = [];
  const consumed = new Set<string>();
  for (const r of ranked) {
    const found = byUrl.get(r.url);
    if (found && !consumed.has(found.id)) {
      ordered.push(found);
      consumed.add(found.id);
    }
  }
  const rest = enriched.filter((s) => !consumed.has(s.id)).sort((a, b) => b.score - a.score);
  return [...ordered, ...rest];
}

/**
 * Comprobación ultrarrápida de salud en segundo plano (no bloqueante)
 */
export async function quickProbeServerHealth(server: ScoredServer, timeoutMs = 2500): Promise<number | null> {
  if (server.isEmbed) return null; // Los locators no tienen media que sondear
  if (server.notPlayable || server.score < 0) return null; // Páginas crudas/placeholders: nada que sondear
  // VidSrc entrega URLs firmadas y cada sondeo abre otro relay HLS. Dejar que
  // el candidato seleccionado valide su propio manifiesto evita acumular
  // sesiones especulativas y reduce el consumo de memoria del backend.
  const probeProvider = `${server.provider || ''} ${server.sourceSite || ''}`.toLowerCase();
  if (probeProvider.includes('vidsrc')) return null;
  // A canonical provider page is intentionally represented as a refreshable
  // direct candidate so the JIT resolver can upgrade it. It is still HTML,
  // however, and probing it through `/proxy/stream` only creates a noisy
  // Premature close and can make a healthy primary look unavailable.
  if (isRawWebpageUrl(server.url)) return null;
  
  // Usar el proxy anti-CORS para sondear, o la URL directa si ya es local
  const lowerUrl = server.url.toLowerCase();
  const isLocal = lowerUrl.startsWith('http://localhost') || lowerUrl.startsWith('http://127.0.0.1') || lowerUrl.startsWith('/');
  
  if (!isLocal && !lowerUrl.startsWith('http')) {
    return null;
  }
  
  const testUrl = isLocal ? server.url : proxiedStreamUrl(server.url);

  try {
    const start = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Usar GET con Range: bytes=0-50 para máxima compatibilidad (muchos CDNs de streaming rechazan HEAD con 405)
    const res = await fetch(testUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: { Range: 'bytes=0-50' },
    });
    clearTimeout(timer);
    if (res.body) {
      try { res.body.cancel(); } catch {}
    }
    if (res.ok || res.status === 206) {
      return Math.round(performance.now() - start);
    }
    return null;
  } catch {
    return null;
  }
}
