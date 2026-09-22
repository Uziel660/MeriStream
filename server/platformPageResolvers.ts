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
import { parseMegaUrl } from "./resolvers/megaResolver";

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
  /** Health probe for MEGA relays; injectable so resolver tests stay offline. */
  megaHealthCheck?: (url: string) => Promise<boolean>;
}

const defaultDeliveryPlanner = new DeliveryPlanner();

/**
 * A MEGA embed is only a locator. The internal relay is advertised as a
 * playable direct URL only after MEGA returns file metadata. Without this
 * probe a stale/deleted file looks healthy until the player receives a 4xx/5xx
 * and starts an avoidable fallback cascade.
 */
async function defaultMegaHealthCheck(url: string): Promise<boolean> {
  const parsed = parseMegaUrl(url);
  if (!parsed || parsed.kind !== "file") return false;
  try {
    const { probeMegaFile } = await import("./resolvers/megaStream");
    await Promise.race([
      probeMegaFile(parsed.canonicalUrl),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("MEGA metadata timeout")), 5000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

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
 * Detecta una página de episodio de AnimeAV1. GNULA usa estas páginas como
 * espejo para parte de su catálogo de anime; tratarlas como un proveedor
 * canónico permite que el adaptador obtenga el HLS de Zilla en vez de dejar
 * la página HTML como un embed sin resolver.
 */
export function isAnimeAv1PageUrl(rawUrl: string | URL): boolean {
  try {
    const url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
    const host = url.hostname.toLowerCase();
    return /(?:^|\.)animeav1\.com$/i.test(host)
      && /^\/media\/[^/]+\/\d+(?:\.\d+)?\/?$/i.test(url.pathname);
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
    return /(?:^|\.)doramasflix\.(?:io|co|in|net|com)$/i.test(host);
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
    isAnimeAv1PageUrl(rawUrl) ||
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
  if (isAnimeAv1PageUrl(rawUrl)) return "AnimeAV1";
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
      score: isHls ? 100 : isDash ? 95 : 80,
    };
  }

  if (isSupportedServer(c)) {
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
 * Resuelve una URL canónica de página de reproducción de plataforma a un stream directo reproducible.
 */
export async function resolvePlatformPage(
  locator: string,
  options: PlatformPageResolveOptions = {}
): Promise<PlatformPlaybackResolution> {
  const cleanUrl = locator.trim();
  const provider = getPlatformProviderName(cleanUrl);
  const now = options.now ? options.now() : Date.now();

  let streamUrl = "";
  let availableStreams: string[] = [];

  try {
    if (options.streamExtractor) {
      const extracted = await options.streamExtractor(cleanUrl);
      streamUrl = extracted.stream_url || "";
      availableStreams = extracted.all_available_streams || [];
    } else {
      if (isDoramasflixPageUrl(cleanUrl)) {
        const { DoramasflixAdapter } = await import("./scrapers/adapters/DoramasflixAdapter");
        const adapter = new DoramasflixAdapter();
        const extracted = await Promise.race([
          adapter.extractStream(cleanUrl),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000)),
        ]);
        streamUrl = extracted.stream_url || "";
        availableStreams = extracted.all_available_streams || [];
      } else if (isLatAnimePageUrl(cleanUrl)) {
        const { LatAnimeAdapter } = await import("./scrapers/adapters/LatAnimeAdapter");
        const adapter = new LatAnimeAdapter();
        const extracted = await Promise.race([
          adapter.extractStream(cleanUrl),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000)),
        ]);
        streamUrl = extracted.stream_url || "";
        availableStreams = extracted.all_available_streams || [];
      } else if (isGnulaPageUrl(cleanUrl)) {
        const { GnulaAdapter } = await import("./scrapers/adapters/GnulaAdapter");
        const adapter = new GnulaAdapter();
        const extracted = await Promise.race([
          adapter.extractStream(cleanUrl),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000)),
        ]);
        streamUrl = extracted.stream_url || "";
        availableStreams = extracted.all_available_streams || [];
      } else if (isTioAnimePageUrl(cleanUrl)) {
        const { TioAnimeAdapter } = await import("./scrapers/adapters/TioAnimeAdapter");
        const adapter = new TioAnimeAdapter();
        const extracted = await Promise.race([
          adapter.extractStream(cleanUrl),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000)),
        ]);
        streamUrl = extracted.stream_url || "";
        availableStreams = extracted.all_available_streams || [];
      } else {
        const { extractStreamsFromUrl } = await import("./scrapers/commonScraperUtils");
        const extracted = await Promise.race([
          extractStreamsFromUrl(cleanUrl),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout")), 12000)),
        ]);
        streamUrl = extracted.stream_url || "";
        availableStreams = extracted.all_available_streams || [];
      }
    }
  } catch {
    // If extraction fails, fall through
  }

  const allCandidates = [streamUrl, ...availableStreams].filter(Boolean);
  const scoredList = allCandidates
    .map((cand) => scoreCandidate(cand, cleanUrl, now))
    .filter((cand): cand is ScoredCandidate => cand !== null)
    .sort((a, b) => b.score - a.score);

  if (scoredList.length === 0) {
    return buildUnresolvedResponse(cleanUrl, provider);
  }

  let resolvedStreamUrl = "";
  let isDirect = false;
  let requiredHeaders: Record<string, string> | undefined;

  const topCandidate = scoredList[0];
  if (topCandidate.isDirect) {
    resolvedStreamUrl = topCandidate.url;
    isDirect = true;
  } else {
    // El orden de prioridad sigue siendo el del ranking, pero las redes de
    // cada candidato se consultan en paralelo. En producción había páginas de
    // TioAnime/Cinecalidad/GNULA con múltiples embeds: evaluar los candidatos
    // en paralelo permite elegir inmediatamente el primer stream nativo disponible.
    const resolvedCandidates = await Promise.all(scoredList.slice(0, 8).map(async (cand) => {
      try {
        const subMeta = await EmbedResolvers.resolveWithMeta(cand.url);
        if (subMeta.resolved && subMeta.url && subMeta.type === "direct") {
          // `resolveWithMeta` can construct the internal MEGA relay without
          // contacting MEGA. Verify the public file first so dead links never
          // become the preferred source and trigger a rapid false cascade.
          if (subMeta.provider === "Mega" || /\/api\/v1\/stream\/mega(?:\?|$)/i.test(subMeta.url)) {
            const megaHealthy = await (options.megaHealthCheck || defaultMegaHealthCheck)(cand.url);
            if (!megaHealthy) return null;
          }
          return {
            candidate: cand,
            url: subMeta.url,
            requiredHeaders: subMeta.requiredHeaders ? { ...subMeta.requiredHeaders } : undefined,
          };
        }

        // `EmbedResolvers` intentionally keeps MEGA `/embed/#!...` locators
        // as embeds. In a platform-page flow we can safely turn a healthy
        // public file into MeriStream's internal relay, which keeps the
        // frontend native and avoids asking it to load a third-party iframe.
        if (!subMeta.resolved || subMeta.type !== "direct") {
          const mega = parseMegaUrl(cand.url);
          if (mega?.kind === "file") {
            const megaHealthy = await (options.megaHealthCheck || defaultMegaHealthCheck)(cand.url);
            if (megaHealthy) {
              return {
                candidate: cand,
                url: `/api/v1/stream/mega?url=${encodeURIComponent(mega.canonicalUrl)}`,
              };
            }
          }
        }
      } catch {}
      return null;
    }));

    // Escoger el primer éxito siguiendo el ranking original, no el orden de
    // llegada, para que la aceleración no cambie la política de calidad.
    const firstResolved = resolvedCandidates.find((entry) => entry !== null);
    if (firstResolved) {
      resolvedStreamUrl = firstResolved.url;
      isDirect = true;
      if (firstResolved.requiredHeaders) requiredHeaders = firstResolved.requiredHeaders;
    }
  }

  if (/vimeos\.[a-z]+/i.test(resolvedStreamUrl) || /p\d+\.vimeos\.zip/i.test(resolvedStreamUrl)) {
    requiredHeaders = { ...VIMEOS_REQUIRED_HEADERS, ...(requiredHeaders || {}) };
  } else if (/goodstream\./i.test(resolvedStreamUrl)) {
    requiredHeaders = { Referer: "https://goodstream.one/", ...(requiredHeaders || {}) };
  } else if (/playmudos\.com|yourupload\.com/i.test(resolvedStreamUrl)) {
    requiredHeaders = { Referer: "https://yourupload.com/", ...(requiredHeaders || {}) };
  } else if (/streamtape\.com|tapecontent\.net/i.test(resolvedStreamUrl)) {
    requiredHeaders = { Referer: "https://streamtape.com/", ...(requiredHeaders || {}) };
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
  const streamExtractor = options?.streamExtractor ?? (async (url: string) => {
    const { LatAnimeAdapter } = await import("./scrapers/adapters/LatAnimeAdapter");
    return new LatAnimeAdapter().extractStream(url);
  });
  return resolvePlatformPage(locator, { ...options, streamExtractor });
}

/** Resolutor específico para gnulahd.nu */
export async function resolveGnulaPage(
  locator: string,
  options?: PlatformPageResolveOptions
): Promise<PlatformPlaybackResolution> {
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
  const streamExtractor = options?.streamExtractor ?? (async (url: string) => {
    const { TioAnimeAdapter } = await import("./scrapers/adapters/TioAnimeAdapter");
    return new TioAnimeAdapter().extractStream(url);
  });
  return resolvePlatformPage(locator, { ...options, streamExtractor });
}

/** Resolutor específico para páginas de episodio AnimeAV1. */
export async function resolveAnimeAv1Page(
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
  const streamExtractor = options?.streamExtractor ?? (async (url: string) => {
    const { DoramasflixAdapter } = await import("./scrapers/adapters/DoramasflixAdapter");
    return new DoramasflixAdapter().extractStream(url);
  });
  return resolvePlatformPage(locator, { ...options, streamExtractor });
}

/** Resolutor específico para tubepelis.com */
export async function resolveTubePelisPage(
  locator: string,
  options?: PlatformPageResolveOptions
): Promise<PlatformPlaybackResolution> {
  return resolvePlatformPage(locator, options);
}
