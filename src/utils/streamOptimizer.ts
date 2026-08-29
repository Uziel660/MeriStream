// src/utils/streamOptimizer.ts
import { proxiedStreamUrl } from './proxiedUrl';
import type { RankedStream } from '../types';
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
  /** Plataforma de origen (animeflv, cinecalidad, latanime…); presente con ranked_streams. */
  sourceSite?: string;
}

/**
 * Hosts de CDN directo conocidos por bloquear el primer intento del navegador
 * con CORS (defecto #4/#9: goodstream en Cinecalidad/LaMovie, acek-cdn en
 * TioPlus, CDNs de tubepelis/cuevana). Para estos, el reproductor enruta por
 * /api/v1/proxy/stream desde el PRIMER intento en vez de dejar que hls.js
 * falle y se recupere (consola limpia y arranque más rápido).
 */
const PROXY_FIRST_HOSTS = [
  'goodstream',
  'acek-cdn',
  'acefile',
  'tubepelis',
  'cuevana',
  'cdn-tnmr.org',
  'tnmr.org',
  'ducvomes.com',
  // CDNs HLS con manifestLoadError directo desde navegador (2026-08-24):
  // sprintcdn (tioplus), owphbf24 (animeflv/playmudos), dramiyos-cdn (latanime)
  'sprintcdn',
  'owphbf24',
  'dramiyos',
];

export function shouldProxyDirectHost(url: string | null | undefined): boolean {
  if (!url) return false;
  const lower = String(url).toLowerCase();
  return PROXY_FIRST_HOSTS.some((h) => lower.includes(h));
}

/**
 * Detecta URLs de media con firma temporal en query (?st=&e=&s=&token=...).
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
      lower.includes('jkanime.net/ver/') ||
      lower.includes('tioanime.com/ver/') ||
      lower.includes('latanime.org/ver/') ||
      lower.includes('wwv.veranimes.net/ver/') ||
      lower.includes('veranimes.net/ver/') ||
      lower.includes('tioplus.app/') ||
      lower.includes('tubepelis.com/pelicula/') ||
      lower.includes('cinecalidad.am/')) &&
    !lower.includes('.m3u8') &&
    !lower.includes('.mp4')
  );
}

/**
 * Detecta si una URL debe cargarse en iframe embed o en motor HLS/video nativo.
 */
export function isEmbedUrl(url: string): boolean {
  if (!url) return false;
  const u = url.toLowerCase();

  // Stream nativo servido por nuestro backend (descifrado Mega on-the-fly): siempre directo
  if (u.includes('/api/v1/stream/mega')) return false;

  // Direct media files (.m3u8, .mp4, .webm, .mkv) are played via native HLS/Video.
  // Extension regex (not substring): evita que ".mp4upload.com" haga match de ".mp4".
  if (
    (/\.(m3u8|mp4|webm|mkv)(\?|#|$)/.test(u)) &&
    !u.includes('mega.nz') &&
    !u.includes('/embed') &&
    !u.includes('/e/')
  ) {
    return false;
  }

  return (
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
export function getProviderName(url: string, index: number): string {
  const u = url.toLowerCase();
  if (u.includes('/api/v1/stream/mega')) return 'Mega Directo (Nativo)';
  if (u.includes('mux.dev') || u.includes('test-streams')) return 'CDN Ultra HLS (Rápido)';
  if (u.includes('commondatastorage.googleapis.com') || u.includes('storage.googleapis')) return 'Google Fast Direct';
  if (u.includes('zilla-networks')) return 'Zilla HLS Network';
  if (u.includes('voe.sx') || u.includes('voe.') || u.includes('byselapuix')) return 'VOE HighSpeed';
  if (u.includes('streamwish')) return 'Streamwish CDN';
  if (u.includes('filemoon')) return 'Filemoon HD';
  if (u.includes('yourupload')) return 'YourUpload';
  if (u.includes('streamtape')) return 'Streamtape CDN';
  if (u.includes('mega.nz')) return 'Mega Cloud';
  if (u.includes('mp4upload.com/embed') || /mp4upload\.com\/[a-z0-9]+$/.test(u)) return 'MP4Upload (Embed)';
  if (u.includes('mp4upload')) return 'MP4Upload HD';
  if (u.includes('vidmoly')) return 'Vidmoly Fast';
  if (u.includes('dood')) return 'Doodstream';
  if (u.includes('fembed')) return 'Fembed HD';
  if (u.includes('mixdrop')) return 'Mixdrop';
  if (u.includes('uqload')) return 'Uqload Fast';
  if (u.includes('animeflv')) return 'AnimeFLV Server';
  if (u.includes('jkanime')) return 'JKanime Server';
  if (u.endsWith('.m3u8') || u.includes('/m3u8/')) return `HLS Master ${index + 1}`;
  if (u.endsWith('.mp4')) return `Direct MP4 ${index + 1}`;
  return `Servidor ${index + 1}`;
}

/**
 * Evalúa y califica un servidor multimedia para ordenar por máxima calidad y mejor salud
 */
export function scoreServer(rawUrl: string, index: number): ScoredServer {
  let url = (rawUrl || '').trim();

  // Página web cruda (ej. tvmaze.com/episodes/..., animeflv.net/ver/...): no es un
  // medio reproducible y un fetch directo desde el navegador muere por CORS.
  // Se marca notPlayable para que la UI la etiquete como "No reproducible".
  if (isRawWebpageUrl(url)) {
    return {
      id: `server-${index}-rawpage`,
      url,
      label: `No reproducible • ${getProviderName(url, index)}`,
      provider: getProviderName(url, index),
      quality: '480p',
      isEmbed: false,
      streamType: 'direct',
      notPlayable: true,
      score: -1000,
      health: 'desconocida',
    };
  }

  // Mega.nz: enrutar por nuestro backend de descifrado on-the-fly (stream nativo Plyr)
  // en vez de iframe /embed/. El fallback al embed se maneja en el reproductor si falla.
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
      label: `No reproducible • ${getProviderName(url, index)}`,
      provider: getProviderName(url, index),
      quality: '480p',
      isEmbed: false,
      streamType: 'direct',
      notPlayable: true,
      score: -1000,
      health: 'desconocida',
    };
  }

  const isEmbed = isEmbedUrl(url);
  const streamType = isEmbed ? 'embed' : 'direct';
  const quality = detectQualityFromUrl(url);
  const provider = getProviderName(url, index);
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
    // Restaurado a la normalidad: El stealth proxy resuelve el 403
    score += 15;
    health = 'excelente';
  } else if (isEmbed) {
    if (u.includes('voe.sx') || u.includes('byselapuix')) {
      health = 'buena';
      score += 10;
    } else if (u.includes('mega.nz')) {
      // Embed legacy de Mega sin clave: reproducible vía iframe pero con ads/limits
      health = 'buena';
      score += 8;
    } else {
      health = 'estable';
    }
  } else if (u.includes('/api/v1/stream/mega')) {
    // Cuota anónima de Mega puede agotarse; el reproductor hace fallback a embed si ocurre
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
  };
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
 */
export function applyBackendTiers(servers: ScoredServer[], ranked: RankedStream[] | undefined): ScoredServer[] {
  if (!ranked || ranked.length === 0) return servers;
  const metaByUrl = new Map(ranked.map((r) => [r.url, r]));
  const enriched = servers.map((s) => {
    const m = metaByUrl.get(s.url);
    return m ? { ...s, tier: m.tier, sourceSite: m.source_site ?? s.sourceSite } : s;
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
export async function quickProbeServerHealth(server: ScoredServer, timeoutMs = 1200): Promise<number | null> {
  if (server.isEmbed) return null; // Los iframes no se pueden sondear por CORS
  if (server.notPlayable || server.score < 0) return null; // Páginas crudas/placeholders: nada que sondear
  
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
    const res = await fetch(testUrl, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { Range: 'bytes=0-100' },
    });
    clearTimeout(timer);
    if (res.ok || res.status === 206) {
      return Math.round(performance.now() - start);
    }
    return null;
  } catch {
    return null;
  }
}
