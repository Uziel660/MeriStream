// server/platformPageResolvers.ts
import { parseStreamExpiry, createResolutionTiming } from "./resolutionMetadata";
import { DeliveryPlanner } from "./deliveryPlanner";
import { PlaybackResolution } from "./types";
import { VIMEOS_REQUIRED_HEADERS } from "./hostProfiles";
import {
  EmbedResolvers,
  isValidProvider,
  isSupportedServer,
} from "./resolvers";

export type PlatformPlaybackResolution = PlaybackResolution & {
  provider: string;
};

export interface PlatformPageResolveOptions {
  streamExtractor?: (url: string) => Promise<{
    stream_url: string;
    all_available_streams: string[];
    title?: string;
  }>;
  now?: () => number;
}

const defaultDeliveryPlanner = new DeliveryPlanner();

/**
 * Detecta si la URL corresponde a una página canónica de LaMovie (lamovie.org, lamovie.to, lamovie.ws).
 */
export function isLaMoviePageUrl(rawUrl: string | URL): boolean {
  try {
    const url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
    const host = url.hostname.toLowerCase();
    return /(?:^|\.)lamovie\.(?:org|to|ws)$/i.test(host);
  } catch {
    return false;
  }
}

/**
 * Detecta si la URL corresponde a una página canónica de CineCalidad (cinecalidad.am, cinecalidad.mx, cinecalidad.im, etc.).
 */
export function isCinecalidadPageUrl(rawUrl: string | URL): boolean {
  try {
    const url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
    const host = url.hostname.toLowerCase();
    return /(?:^|\.)cinecalidad\.[a-z]+$/i.test(host);
  } catch {
    return false;
  }
}

/**
 * Detecta si la URL corresponde a una página canónica de TioPlus (tioplus.app y variantes).
 */
export function isTioPlusPageUrl(rawUrl: string | URL): boolean {
  try {
    const url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
    const host = url.hostname.toLowerCase();
    return /(?:^|\.)tioplus\.[a-z]+$/i.test(host);
  } catch {
    return false;
  }
}

/**
 * Detecta si la URL corresponde a una página canónica de AnimeFLV (animeflv.net, animeflv.or.at, etc.).
 */
export function isAnimeFlvPageUrl(rawUrl: string | URL): boolean {
  try {
    const url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
    const host = url.hostname.toLowerCase();
    return /(?:^|\.)animeflv\.(?:net|or\.at|me|to|ac|or\.am)$/i.test(host);
  } catch {
    return false;
  }
}

/**
 * Detecta si la URL corresponde a una página canónica de JKanime (jkanime.net).
 */
export function isJkanimePageUrl(rawUrl: string | URL): boolean {
  try {
    const url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
    const host = url.hostname.toLowerCase();
    return /(?:^|\.)jkanime\.net$/i.test(host);
  } catch {
    return false;
  }
}

/**
 * Detecta si la URL corresponde a una página canónica de LatAnime (latanime.org, lat-anime.net, etc.).
 */
export function isLatAnimePageUrl(rawUrl: string | URL): boolean {
  try {
    const url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
    const host = url.hostname.toLowerCase();
    return /(?:^|\.)lat(?:-)?anime\.(?:org|net|io)$/i.test(host);
  } catch {
    return false;
  }
}

/**
 * Detecta si la URL corresponde a una página canónica de GNULA (gnulahd.nu, ww3.gnulahd.nu, etc.).
 */
export function isGnulaPageUrl(rawUrl: string | URL): boolean {
  try {
    const url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
    const host = url.hostname.toLowerCase();
    return /(?:^|\.)gnulahd\.nu$/i.test(host) || /(?:^|\.)gnula\.(?:nu|se|cc)$/i.test(host);
  } catch {
    return false;
  }
}

/**
 * Detecta si la URL corresponde a una página canónica de TioAnime (tioanime.com).
 */
export function isTioAnimePageUrl(rawUrl: string | URL): boolean {
  try {
    const url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
    const host = url.hostname.toLowerCase();
    return /(?:^|\.)tioanime\.com$/i.test(host);
  } catch {
    return false;
  }
}

/**
 * Detecta si la URL corresponde a una página canónica de VerAnimes (veranimes.net, wwv.veranimes.net).
 */
export function isVerAnimesPageUrl(rawUrl: string | URL): boolean {
  try {
    const url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
    const host = url.hostname.toLowerCase();
    return /(?:^|\.)veranimes\.net$/i.test(host);
  } catch {
    return false;
  }
}

/**
 * Detecta si la URL corresponde a una página canónica de Doramasflix (doramasflix.io, etc.).
 */
export function isDoramasflixPageUrl(rawUrl: string | URL): boolean {
  try {
    const url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
    const host = url.hostname.toLowerCase();
    return /(?:^|\.)doramasflix\.(?:io|co|in)$/i.test(host);
  } catch {
    return false;
  }
}

/**
 * Detecta si la URL corresponde a una página canónica de TubePelis (tubepelis.com).
 */
export function isTubePelisPageUrl(rawUrl: string | URL): boolean {
  try {
    const url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
    const host = url.hostname.toLowerCase();
    return /(?:^|\.)tubepelis\.com$/i.test(host);
  } catch {
    return false;
  }
}

/**
 * Detecta si la URL pertenece a cualquiera de las plataformas canónicas soportadas (no siendo stream directo).
 */
export function isPlatformPageUrl(rawUrl: string | URL): boolean {
  const urlStr = typeof rawUrl === "string" ? rawUrl : rawUrl.href;
  if (EmbedResolvers.isDirectMediaUrl(urlStr)) return false;
  return (
    isLaMoviePageUrl(rawUrl) ||
    isCinecalidadPageUrl(rawUrl) ||
    isTioPlusPageUrl(rawUrl) ||
    isAnimeFlvPageUrl(rawUrl) ||
    isJkanimePageUrl(rawUrl) ||
    isLatAnimePageUrl(rawUrl) ||
    isGnulaPageUrl(rawUrl) ||
    isTioAnimePageUrl(rawUrl) ||
    isVerAnimesPageUrl(rawUrl) ||
    isDoramasflixPageUrl(rawUrl) ||
    isTubePelisPageUrl(rawUrl)
  );
}

/**
 * Retorna el nombre legible de la plataforma canónica.
 */
export function getPlatformProviderName(rawUrl: string | URL): string {
  if (isLaMoviePageUrl(rawUrl)) return "LaMovie";
  if (isCinecalidadPageUrl(rawUrl)) return "Cinecalidad";
  if (isTioPlusPageUrl(rawUrl)) return "TioPlus";
  if (isAnimeFlvPageUrl(rawUrl)) return "AnimeFLV";
  if (isJkanimePageUrl(rawUrl)) return "JKanime";
  if (isLatAnimePageUrl(rawUrl)) return "LatAnime";
  if (isGnulaPageUrl(rawUrl)) return "Gnula";
  if (isTioAnimePageUrl(rawUrl)) return "TioAnime";
  if (isVerAnimesPageUrl(rawUrl)) return "VerAnimes";
  if (isDoramasflixPageUrl(rawUrl)) return "Doramasflix";
  if (isTubePelisPageUrl(rawUrl)) return "TubePelis";
  return "Desconocido";
}

/**
 * Evalúa si un HLS directo firmado está vencido y carece de página canónica.
 */
export function checkExpiredDirectStream(
  url: string,
  now: number = Date.now()
): PlatformPlaybackResolution | null {
  if (!EmbedResolvers.isDirectMediaUrl(url) || EmbedResolvers.isPlaceholderUrl(url)) {
    return null;
  }
  const { expiresAt } = parseStreamExpiry(url);
  if (expiresAt !== undefined && expiresAt <= now) {
    const provider = EmbedResolvers.getProviderName(url);
    return {
      url,
      original_url: url,
      canonical_locator: undefined,
      provider,
      resolved: false,
      type: "direct",
      delivery_mode: "embed",
      is_proxyable: false,
      is_refreshable: false,
      expires_at: expiresAt,
      refresh_after: expiresAt,
      failure_reason: "expired_without_locator",
    };
  }
  return null;
}

function buildUnresolvedResponse(
  cleanUrl: string,
  provider: string
): PlatformPlaybackResolution {
  return {
    url: cleanUrl,
    original_url: cleanUrl,
    canonical_locator: cleanUrl,
    provider,
    resolved: false,
    type: "embed",
    delivery_mode: "embed",
    is_proxyable: false,
    is_refreshable: false,
    failure_reason: "unresolved",
    expires_at: undefined,
    refresh_after: undefined,
  };
}

interface ScoredCandidate {
  url: string;
  isDirect: boolean;
  score: number;
}

/**
 * Evalúa y puntúa candidatos para seleccionar el mejor stream reproducible.
 * Prioridad:
 *   1. HLS (.m3u8) vigente no placeholder (score 100)
 *   2. MP4 / WebM directo vigente (score 80)
 *   3. Servidor de embed soportado/reconocido (score 50)
 *   4. Embed genérico reproducible (score 20)
 * Excluye: URLs expiradas, placeholders, dead providers y la página HTML canónica original.
 */
function scoreCandidate(candidateUrl: string, cleanUrl: string, now: number): ScoredCandidate | null {
  const c = (candidateUrl || "").trim();
  if (!c) return null;

  // No usar la página web original como stream
  if (c === cleanUrl) return null;

  // Descartar páginas HTML de la misma plataforma sin extensión de video
  if (isPlatformPageUrl(c)) return null;

  // Descartar placeholders y dominios de proveedores muertos
  if (EmbedResolvers.isPlaceholderUrl(c)) return null;
  if (!isValidProvider(c)) return null;

  const isDirect = EmbedResolvers.isDirectMediaUrl(c);
  if (isDirect) {
    const { expiresAt } = parseStreamExpiry(c);
    if (expiresAt !== undefined && expiresAt <= now) {
      // Expirado: no reproducible
      return null;
    }
    const lower = c.toLowerCase();
    const isHls = lower.includes(".m3u8") || lower.includes("/m3u8/") || lower.includes("hls-vod");
    const isDash = lower.includes(".mpd");
    return {
      url: c,
      isDirect: true,
      score: isHls || isDash ? 100 : 80,
    };
  }

  // Embed reproducible
  if (isSupportedServer(c) || c.includes("mega.nz") || /vimeos\.[a-z]+/i.test(c) || c.includes("goodstream.")) {
    return {
      url: c,
      isDirect: false,
      score: 50,
    };
  }

  return {
    url: c,
    isDirect: false,
    score: 20,
  };
}

/**
 * Resuelve una página canónica de LaMovie, CineCalidad o TioPlus a un PlaybackResolution completo.
 * Atiende una sola fuente seleccionada (sin llamadas masivas ni crawling).
 */
export async function resolvePlatformPage(
  locator: string,
  options: PlatformPageResolveOptions = {}
): Promise<PlatformPlaybackResolution> {
  const cleanUrl = (locator || "").trim();
  if (!cleanUrl) {
    return {
      url: "",
      original_url: "",
      canonical_locator: undefined,
      provider: "Desconocido",
      resolved: false,
      type: "embed",
      delivery_mode: "embed",
      is_proxyable: false,
      is_refreshable: false,
      failure_reason: "empty_locator",
    };
  }

  const provider = getPlatformProviderName(cleanUrl);
  const now = options.now ? options.now() : Date.now();

  let extracted: { stream_url: string; all_available_streams: string[]; title?: string } | null = null;
  try {
    // Carga diferida para evitar un ciclo de inicialización:
    // resolvers -> platformPageResolvers -> universalScraper -> ScraperManager
    // -> adaptadores -> resolvers. Los tests pueden inyectar un extractor y la
    // producción solo importa el scraper cuando realmente se solicita JIT.
    const extractor = options.streamExtractor ?? (async (url: string) => {
      const { extractStreamFromUrl } = await import("./universalScraper");
      return Promise.race([
        extractStreamFromUrl(url),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout resolviendo plataforma (6.5s)")), 6500)
        ),
      ]);
    });
    extracted = await extractor(cleanUrl);
  } catch {
    extracted = null;
  }

  if (!extracted) {
    return buildUnresolvedResponse(cleanUrl, provider);
  }

  const rawCandidates: string[] = [];
  if (extracted.stream_url) rawCandidates.push(extracted.stream_url);
  if (Array.isArray(extracted.all_available_streams)) {
    for (const s of extracted.all_available_streams) {
      if (s && !rawCandidates.includes(s)) rawCandidates.push(s);
    }
  }

  const scoredList: ScoredCandidate[] = [];
  for (const candidate of rawCandidates) {
    const scored = scoreCandidate(candidate, cleanUrl, now);
    if (scored) scoredList.push(scored);
  }

  if (scoredList.length === 0) {
    // Ningún stream reproducible encontrado: nunca convertir en embed válido
    return buildUnresolvedResponse(cleanUrl, provider);
  }

  // Ordenar por score descendente: elegir el mejor stream
  scoredList.sort((a, b) => b.score - a.score);
  const best = scoredList[0];

  let resolvedStreamUrl = best.url;
  let isDirect = best.isDirect;
  let requiredHeaders: Record<string, string> | undefined;

  // Si el mejor candidato es un embed (YourUpload, Vimeos, Goodstream, Mega, StreamWish),
  // intentar desofuscarlo a stream directo de inmediato probando los mejores candidatos
  if (!isDirect) {
    for (const cand of scoredList.slice(0, 3)) {
      try {
        const subMeta = await EmbedResolvers.resolveWithMeta(cand.url);
        if (subMeta.resolved && subMeta.url && subMeta.type === "direct") {
          resolvedStreamUrl = subMeta.url;
          isDirect = true;
          if (subMeta.requiredHeaders) {
            requiredHeaders = { ...subMeta.requiredHeaders };
          }
          break;
        }
      } catch {}
    }
  }

  if (/vimeos\.[a-z]+/i.test(resolvedStreamUrl) || /p\d+\.vimeos\.zip/i.test(resolvedStreamUrl)) {
    requiredHeaders = { ...VIMEOS_REQUIRED_HEADERS, ...(requiredHeaders || {}) };
  } else if (/goodstream\./i.test(resolvedStreamUrl)) {
    requiredHeaders = { Referer: "https://goodstream.one/", ...(requiredHeaders || {}) };
  } else if (/playmudos\.com|yourupload\.com/i.test(resolvedStreamUrl)) {
    requiredHeaders = { Referer: "https://yourupload.com/", ...(requiredHeaders || {}) };
  }

  // Un embed que no se pudo convertir a media nativa no es reproducible por
  // MeriStream: nunca lo anuncies como éxito porque el frontend no debe abrir
  // iframes externos. El coordinador lo tratará como candidato fallido y podrá
  // continuar con la siguiente fuente del proveedor.
  if (!isDirect) {
    return buildUnresolvedResponse(cleanUrl, provider);
  }

  const isProxyable = true;
  const timing = createResolutionTiming({
    originalUrl: cleanUrl,
    upstreamUrl: resolvedStreamUrl,
    provider,
    now,
  });

  const partialMeta = {
    url: resolvedStreamUrl,
    original_url: cleanUrl,
    canonical_locator: cleanUrl,
    provider,
    resolved: true,
    type: isDirect ? ("direct" as const) : ("embed" as const),
    is_proxyable: isProxyable,
    is_refreshable: true,
    requiredHeaders,
  };

  const delivery_mode = defaultDeliveryPlanner.classify(partialMeta);

  return {
    ...partialMeta,
    delivery_mode,
    resolved_at: timing.resolved_at,
    refresh_after: timing.refresh_after,
    expires_at: timing.expires_at,
    resolution_id: timing.resolution_id,
    generation: timing.generation,
    failure_reason: undefined,
  };
}

/** Resolutor específico para lamovie.org */
export async function resolveLaMoviePage(
  locator: string,
  options?: PlatformPageResolveOptions
): Promise<PlatformPlaybackResolution> {
  return resolvePlatformPage(locator, options);
}

/** Resolutor específico para cinecalidad.am y variantes */
export async function resolveCinecalidadPage(
  locator: string,
  options?: PlatformPageResolveOptions
): Promise<PlatformPlaybackResolution> {
  return resolvePlatformPage(locator, options);
}

/** Resolutor específico para tioplus.app */
export async function resolveTioPlusPage(
  locator: string,
  options?: PlatformPageResolveOptions
): Promise<PlatformPlaybackResolution> {
  return resolvePlatformPage(locator, options);
}

/** Resolutor específico para animeflv */
export async function resolveAnimeFlvPage(
  locator: string,
  options?: PlatformPageResolveOptions
): Promise<PlatformPlaybackResolution> {
  return resolvePlatformPage(locator, options);
}

/** Resolutor específico para jkanime.net */
export async function resolveJkanimePage(
  locator: string,
  options?: PlatformPageResolveOptions
): Promise<PlatformPlaybackResolution> {
  return resolvePlatformPage(locator, options);
}

/** Resolutor específico para latanime */
export async function resolveLatAnimePage(
  locator: string,
  options?: PlatformPageResolveOptions
): Promise<PlatformPlaybackResolution> {
  return resolvePlatformPage(locator, options);
}

/** Resolutor específico para gnulahd.nu */
export async function resolveGnulaPage(
  locator: string,
  options?: PlatformPageResolveOptions
): Promise<PlatformPlaybackResolution> {
  // GNULA does not render its real servers in the initial HTML.  The page
  // exposes a public WordPress player endpoint after the user presses play;
  // use the same adapter here so JIT playback sees those servers too instead
  // of treating the canonical episode page as an unresolved embed.
  const streamExtractor = options?.streamExtractor ?? (async (url: string) => {
    const { GnulaAdapter } = await import("./scrapers/adapters/GnulaAdapter");
    return new GnulaAdapter().extractStream(url);
  });
  return resolvePlatformPage(locator, { ...options, streamExtractor });
}

/** Resolutor específico para tioanime.com */
export async function resolveTioAnimePage(
  locator: string,
  options?: PlatformPageResolveOptions
): Promise<PlatformPlaybackResolution> {
  return resolvePlatformPage(locator, options);
}

/** Resolutor específico para veranimes.net */
export async function resolveVerAnimesPage(
  locator: string,
  options?: PlatformPageResolveOptions
): Promise<PlatformPlaybackResolution> {
  return resolvePlatformPage(locator, options);
}

/** Resolutor específico para doramasflix */
export async function resolveDoramasflixPage(
  locator: string,
  options?: PlatformPageResolveOptions
): Promise<PlatformPlaybackResolution> {
  return resolvePlatformPage(locator, options);
}

/** Resolutor específico para tubepelis.com */
export async function resolveTubePelisPage(
  locator: string,
  options?: PlatformPageResolveOptions
): Promise<PlatformPlaybackResolution> {
  return resolvePlatformPage(locator, options);
}
