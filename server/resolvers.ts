// server/resolvers.ts
import * as crypto from "crypto";
import { unpackDeanEdwards, unpackGeneric, extractMediaUrlsFromCode } from "./scrapers/utils/jsUnpacker";
import { VimeosResolver } from "./scrapers/vimeosResolver";
import { parseMegaUrl } from "./resolvers/megaResolver";
import { resolveHexload } from "./scrapers/utils/obscureResolvers";
import { resolveDoodstream } from "./resolvers/doodstreamResolver";
import { resolveUqload } from "./resolvers/uqloadResolver";
import { resolveVidhide } from "./resolvers/vidhideResolver";
import { VIMEOS_REQUIRED_HEADERS } from "./hostProfiles";
import { parseStreamExpiry } from "./resolutionMetadata";
import { resolveZokoAnime, isZokoAnimeUrl, ZOKO_REQUIRED_HEADERS } from "./resolvers/zokoanimeResolver";
import { resolveMegaplay, isMegaplayUrl, MEGAPLAY_REQUIRED_HEADERS } from "./resolvers/megaplayResolver";
import { buildVidSrcMirrorUrls, resolveVidSrcEmbed } from "./providers/api/vidsrcClient";
import { episodeLinks, fetchHianimesEpisode, hianimesSlugFromUrl, isHianimesWatchUrl } from "./resolvers/hianimesResolver";
import {
  isPlatformPageUrl,
  isLaMoviePageUrl,
  isCinecalidadPageUrl,
  isTioPlusPageUrl,
  isAnimeFlvPageUrl,
  isJkanimePageUrl,
  isLatAnimePageUrl,
  isGnulaPageUrl,
  isTioAnimePageUrl,
  isVerAnimesPageUrl,
  isDoramasflixPageUrl,
  isTubePelisPageUrl,
  resolvePlatformPage,
  resolveLaMoviePage,
  resolveCinecalidadPage,
  resolveTioPlusPage,
  resolveAnimeFlvPage,
  resolveJkanimePage,
  resolveLatAnimePage,
  resolveGnulaPage,
  resolveTioAnimePage,
  resolveVerAnimesPage,
  resolveDoramasflixPage,
  resolveTubePelisPage,
} from "./platformPageResolvers";

// ── Blacklist global de proveedores muertos ──────────────────────────────────
// Dominios verificados caídos: ninguna resolución server-side rinde con ellos,
// se filtran antes de gastar fetches en el pipeline de auditoría.
export const DEAD_PROVIDER_DOMAINS: ReadonlySet<string> = new Set([
  "voe.sx",
  "voe",
  "mixdrop",
  "mxdrop",
  "filemoon",
]);

/** false si la URL contiene alguno de los dominios muertos de la blacklist. */
export function isValidProvider(url: string): boolean {
  const u = (url || "").toLowerCase();
  if (!u) return false;
  for (const domain of DEAD_PROVIDER_DOMAINS) {
    if (u.includes(domain)) return false;
  }
  return true;
}

// ── Whitelist de servidores que SÍ podemos resolver a media nativo ───────────
// Usado por los adaptadores (ej. VerAnimes) para PRIORIZAR estos servidores e
// IGNORAR los ofuscados/raros no soportados. Debe mantenerse en sincronía con
// las ramas de EmbedResolvers.resolve().
export const SUPPORTED_SERVER_HOST_PATTERNS: ReadonlyArray<RegExp> = [
  /mega\.nz/i,
  /vimeos\.[a-z]+/i,
  /mp4upload\.com/i,
  /yourupload\.com/i,
  /ok\.ru/i,
  /voe\.sx/i,
  /voe\./i,
  /byse[a-z0-9-]*\.[a-z]+/i,
  /byselapuix/i,
  /primeload\.co/i,
  /byseqekaho\.com/i,
  /bysekoze\.com/i,
  /hexload/i,
  /streamtape\.(?:com|to)/i,
  /streamwish/i,
  /filemoon/i,
  /vidmoly/i,
  /upstream/i,
  /fastre/i,
  /streamhide/i,
  /swhoi/i,
  /dood/i,
  /dsvplay/i,
  /ds2play/i,
  /do7go/i,
  /d000d/i,
  /uqload/i,
  /vidhide/i,
  /vixhide/i,
  /hqq\./i,
  /waaw/i,
  /divxplayer/i,
  /cvary\.org/i,
  /zilla-networks\.com/i,
  /zokoanime\.video/i,
];

/** true si la URL pertenece a un servidor que EmbedResolvers puede resolver a media renderable. */
export function isSupportedServer(url: string): boolean {
  const u = (url || "").toLowerCase();
  if (!u) return false;
  return SUPPORTED_SERVER_HOST_PATTERNS.some((p) => p.test(u));
}

// ── VimeosResolver: extractor del m3u8 maestro ──────────────────────────────
// Fetch al HTML del embed (https://vimeos.net/embed-xyz.html) + regex sobre el
// script de configuración del player (objeto sources, plano o Packed Dean Edwards).
// VIMEOS_REQUIRED_HEADERS se importa de hostProfiles.ts (fuente única por host).

const FETCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const VIMEOS_EMBED_TIMEOUT_MS = 8_000;

export interface VimeosResolution {
  /** URL maestra .m3u8 lista para HLS; "" si no se pudo resolver */
  url: string;
  /**
   * Headers que el nodo CDN exige al reproducir (re-bisección 2026-08-24:
   * UA Chrome completo + Accept-Encoding, sin Referer/Origin — ver
   * hostProfiles.VIMEOS_REQUIRED_HEADERS). El proxy los aplica vía perfil.
   */
  requiredHeaders: Record<string, string>;
}

/**
 * Resuelve https://vimeos.net/embed-{id}.html (o /e/{id}) a su m3u8 maestro:
 * fetch HTML → desempaquetar Packer si existe → regex sobre `sources` → .m3u8.
 * Siempre incluye requiredHeaders aunque caiga al embed original.
 */
export async function resolveVimeosEmbed(embedUrl: string): Promise<VimeosResolution> {
  const fail = () => ({ url: "", requiredHeaders: { ...VIMEOS_REQUIRED_HEADERS } });
  const url = (embedUrl || "").trim();
  if (!url || !VimeosResolver.isVimeosUrl(url) || VimeosResolver.isDownloadHostUrl(url)) {
    return fail();
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VIMEOS_EMBED_TIMEOUT_MS);
    let html: string;
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": FETCH_UA,
          Referer: "https://vimeos.net/",
        },
      });
      if (!res.ok) return fail();
      html = await res.text();
    } finally {
      clearTimeout(timer);
    }

    if (html.includes("File is no longer available")) return fail();

    // 1. Objeto sources del player (en texto claro o desempaquetado)
    const unpacked = unpackGeneric(html);
    const sourceObjMatch =
      unpacked.match(/sources\s*[:=]\s*\{[^}]*file\s*[:=]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i) ||
      html.match(/sources\s*[:=]\s*\{[^}]*file\s*[:=]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
    if (sourceObjMatch) return { url: sourceObjMatch[1], requiredHeaders: { ...VIMEOS_REQUIRED_HEADERS } };

    // 2. Cualquier .m3u8 en el código del player (master primero)
    const mediaUrls = extractMediaUrlsFromCode(unpacked);
    const m3u8 = mediaUrls.find((u) => u.includes(".m3u8"));
    if (m3u8) return { url: m3u8, requiredHeaders: { ...VIMEOS_REQUIRED_HEADERS } };
  } catch {
    // red caída / timeout → url vacía
  }
  return fail();
}

// ── MegaResolver Universal: normalización de URLs de Mega ───────────────────

export interface NormalizedMega {
  /** ID público del archivo */
  fileId: string;
  /** Clave de descifrado del enlace */
  fileKey: string;
  /** URL canónica https://mega.nz/file/{ID}#{KEY} */
  canonicalUrl: string;
  /** URL iframe https://mega.nz/embed/{ID}#{KEY} */
  embedUrl: string;
}


/**
 * Extrae el ID (+key) de cualquier variante de URL pública de Mega
 * (/file/, /#!legacy/, /embed/) y devuelve la forma normalizada.
 * Devuelve null si la URL no es de Mega o no se reconoce.
 */
export function normalizeMegaUrl(url: string): NormalizedMega | null {
  const parsed = parseMegaUrl(url);
  if (!parsed || parsed.kind !== "file") return null;
  return {
    fileId: parsed.fileId,
    fileKey: parsed.fileKey,
    canonicalUrl: parsed.canonicalUrl,
    embedUrl: parsed.embedUrl,
  };
}

export interface ResolveContext {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface ProviderCapabilities {
  supportsDirect: boolean;
  supportsProxy: boolean;
  supportsEmbed: boolean;
  renewable: boolean;
  requiresHeaders: boolean;
}

export interface ProviderResolver {
  readonly name: string;
  matches(url: URL): boolean;
  resolve(locator: string, context?: ResolveContext): Promise<ResolvedStreamMeta>;
  capabilities: ProviderCapabilities;
}

export interface ResolvedStreamMeta {
  url: string;
  original_url: string;
  resolved: boolean;
  type: "direct" | "embed";
  provider: string;
  /** Cabeceras que el nodo CDN exige al reproducir (403 sin ellas). */
  requiredHeaders?: Record<string, string>;
  /** Pistas WebVTT descubiertas junto al stream (cuando el proveedor las expone). */
  subtitles?: Array<{ id?: string; label?: string; language?: string; src: string; is_default?: boolean }>;
  /** Zoko distingue pistas VTT externas de texto incrustado en la imagen. */
  subtitle_mode?: "external" | "burned_in" | "unknown";
  /** Pistas de audio declaradas por el master HLS del proveedor. */
  audio_tracks?: Array<{ id: string; label?: string | null; language?: string | null; url?: string | null; is_default?: boolean }>;
  /** true si la URL directa vigente puede entregarse mediante una sesión proxy. */
  is_proxyable?: boolean;
  /** true si existe un localizador estable capaz de producir una URL nueva. */
  is_refreshable?: boolean;
  /** Localizador estable re-resoluble para renovar la URL directa firmada. */
  canonical_locator?: string;
  /** El resolver crudo puede omitirlos; ResolutionCoordinator los completa. */
  resolved_at?: number;
  refresh_after?: number;
  expires_at?: number;
  resolution_id?: string;
  generation?: string;
  expiration_source?: string;
  /** Motivo estable para que API/UI distingan expiración de un fallo genérico. */
  failure_reason?:
    | "empty_locator"
    | "expired_without_locator"
    | "unresolved"
    | "unsafe_url"
    | "provider_blocked"
    | "drm_or_captcha";
  delivery_mode?: "direct" | "direct_trial" | "proxy_required" | "embed";
}

function hasSignedMediaQuery(rawUrl: string): boolean {
  try {
    const params = new URL(rawUrl).searchParams;
    return [
      "t", "token", "jwt", "access_token", "authorization", "expires", "expiry",
      "exp", "s", "e", "sig", "signature", "hash", "auth", "hdnts", "policy",
      "key-pair-id",
    ].some((key) => params.has(key));
  } catch {
    return false;
  }
}

function isZokoCdnUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).hostname.toLowerCase() === "hls2.aniwatchtv.uk";
  } catch {
    return false;
  }
}

export class EmbedResolvers {
  private constructor() {}
  private static readonly DEFAULT_TIMEOUT = 8000;
  private static readonly DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };

  /**
   * Determina si una URL representa un stream directo (.m3u8, .mp4, .webm)
   */
  public static isDirectMediaUrl(url: string): boolean {
    if (!url) return false;
    const u = url.toLowerCase();
    return (
      /\.(m3u8|mpd|mp4|webm)(\?|$)/i.test(u) ||
      u.includes("/m3u8/") ||
      u.includes("hls-vod") ||
      u.includes("/api/v1/stream/mega")
    );
  }

  /**
   * Detecta streams placeholder servidos por el host (ej. VOE devuelve Big Buck Bunny
   * cuando el archivo real cayó). Deben tratarse como inválidos para forzar failover.
   */
  public static isPlaceholderUrl(url: string): boolean {
    if (!url) return false;
    const u = url.toLowerCase();
    return (
      u.includes("big_buck_bunny") ||
      u.includes("big-buck-bunny") ||
      u.includes("bigbuckbunny") ||
      // Demo genérico usado por CDNs cuando el archivo no existe
      (u.includes("sample") && u.includes("mp4") && !u.includes("/sample/")) ||
      u.endsWith("_5mb.mp4")
    );
  }

  /**
   * Obtiene el nombre del proveedor legible a partir de la URL
   */
  public static getProviderName(url: string): string {
    const u = (url || "").toLowerCase();
    if (u.includes("lamovie.")) return "LaMovie";
    if (u.includes("cinecalidad")) return "Cinecalidad";
    if (u.includes("tioplus")) return "TioPlus";
    if (u.includes("hianimes") || u.includes("zokoanime")) return "HiAnimes";
    if (u.includes("mega.nz") || u.includes("/api/v1/stream/mega")) return "Mega";
    if (u.includes("mp4upload.com")) return "MP4Upload";
    if (u.includes("voe.sx") || u.includes("voe.") || u.includes("byselapuix")) return "VOE";
    if (u.includes("streamtape")) return "Streamtape";
    if (u.includes("yourupload.com") || u.includes("playmudos")) return "YourUpload";
    if (u.includes("ok.ru")) return "Okru";
    if (u.includes("filemoon")) return "Filemoon";
    if (u.includes("streamwish") || u.includes("swhoi") || u.includes("premilkyway") || u.includes("wishonly") || u.includes("sfastwish") || u.includes("flaswish")) return "StreamWish";
    if (u.includes("vidmoly")) return "Vidmoly";
    if (u.includes("dood") || u.includes("do7go") || u.includes("ds2play")) return "DoodStream";
    // vimeos rota TLD en sus nodos (s{N}.vimeos.net, vimeos.zip, p{N}.vimeos.zip)
    if (/vimeos\.[a-z]+/i.test(u)) return "Vimeos";
    if (u.includes("mixdrop") || u.includes("mxdrop")) return "Mixdrop";
    if (u.includes("hqq.tv") || u.includes("waaw")) return "Netu/HQQ";
    if (u.includes("byseqekaho.com") || u.includes("byselapuix.com") || u.includes("bysekoze")) return "Bysekoze";
    if (u.includes("sprintcdn") || /edge\d+-(?:[a-z-]+-)??sprintcdn\./i.test(u)) return "SprintCDN";
    if (u.includes("hexload")) return "Hexload";
    if (u.includes("uqload")) return "Uqload";
    if (u.includes("goodstream")) return "Goodstream";
    if (u.includes("vidhide") || u.includes("vixhide") || u.includes("dramiyos-cdn")) return "Vidhide";
    if (u.includes("animeflv")) return "AnimeFLV";
    if (u.includes("jkanime")) return "JKanime";
    if (u.includes("tioanime")) return "TioAnime";
    if (u.includes("veranimes")) return "VerAnimes";
    if (u.includes("latanime")) return "LatAnime";
    if (u.includes("cfglobalcdn.com")) return "Fast CDN (HLS)";
    return "Servidor";
  }

  /**
   * Resuelve la URL real directa (.m3u8 / .mp4) a partir de una URL de iframe/embed con metadata completa.
   */
  public static async resolveWithMeta(iframeUrl: string): Promise<ResolvedStreamMeta> {
    const rawUrl = (iframeUrl || "").trim();
    if (!rawUrl) {
      return {
        url: "",
        original_url: "",
        resolved: false,
        type: "embed",
        provider: "Desconocido",
        is_proxyable: false,
        is_refreshable: false,
        failure_reason: "empty_locator",
      };
    }

    // ZokoAnime embeds are discovered by the HiAnimes catalog adapter, but the
    // playback locator belongs to ZokoAnime. Keep that identity in the delivery
    // response so the player labels the source accurately.
    const provider = isZokoAnimeUrl(rawUrl) ? "ZokoAnime" : this.getProviderName(rawUrl);

    // Si ya es un stream directo, retornar inmediatamente (salvo placeholders del host).
    // Semántica de renovación: una URL directa con expiración explícita (firmada) es
    // reproducible mientras no venció, pero NO es renovable — renovarla exige re-resolver
    // un embed o localizador estable, no la propia URL firmada. Por eso canonical_locator
    // queda sin definir en URLs firmadas y solo se promueve en URLs estables sin firma.
    if (this.isDirectMediaUrl(rawUrl) && !this.isPlaceholderUrl(rawUrl)) {
      if (isZokoCdnUrl(rawUrl)) {
        return {
          url: rawUrl,
          original_url: rawUrl,
          resolved: true,
          type: "direct",
          provider,
          delivery_mode: "direct_trial",
          is_proxyable: true,
          is_refreshable: false,
          requiredHeaders: { ...ZOKO_REQUIRED_HEADERS },
        };
      }
      const { expiresAt } = parseStreamExpiry(rawUrl);
      const hasExplicitExpiry = expiresAt !== undefined;
      const providerHeaders = provider === "Vimeos"
        ? { ...VIMEOS_REQUIRED_HEADERS }
        : undefined;
      if (hasExplicitExpiry) {
        const explicitlyExpired = expiresAt <= Date.now();
        return {
          url: rawUrl,
          original_url: rawUrl,
          canonical_locator: undefined,
          resolved: !explicitlyExpired,
          type: "direct",
          provider,
          delivery_mode: !explicitlyExpired ? "direct_trial" : "embed",
          is_proxyable: !explicitlyExpired,
          is_refreshable: false,
          ...(!explicitlyExpired && providerHeaders ? { requiredHeaders: providerHeaders } : {}),
          ...(explicitlyExpired
            ? {
                failure_reason: "expired_without_locator" as const,
                expires_at: expiresAt,
                refresh_after: expiresAt,
              }
            : {}),
        };
      }
      // Un token opaco (por ejemplo `t=...`) también es una firma aunque no revele
      // su deadline. No debe promoverse como locator renovable.
      const hasOpaqueSignature = hasSignedMediaQuery(rawUrl);
      return {
        url: rawUrl,
        original_url: rawUrl,
        resolved: true,
        type: "direct",
        provider,
        delivery_mode: "direct_trial",
        is_proxyable: true,
        is_refreshable: !hasOpaqueSignature,
        ...(providerHeaders ? { requiredHeaders: providerHeaders } : {}),
        ...(!hasOpaqueSignature ? { canonical_locator: rawUrl } : {}),
      };
    }

    // Si es una página canónica de plataforma soportada (LaMovie, CineCalidad, TioPlus),
    // resolver mediante su resolutor específico
    if (isPlatformPageUrl(rawUrl)) {
      return resolvePlatformPage(rawUrl);
    }

    // Zoko exposes subtitles and the HLS URL in the same payload; keep both
    // so the frontend can present captions without a second provider request.
    if (isZokoAnimeUrl(rawUrl)) {
      const zoko = await resolveZokoAnime(rawUrl);
      if (zoko.url && !this.isPlaceholderUrl(zoko.url)) {
        return {
          url: zoko.url,
          original_url: rawUrl,
          canonical_locator: rawUrl,
          resolved: true,
          type: "direct",
          provider,
          delivery_mode: "direct_trial",
          is_proxyable: true,
          is_refreshable: true,
          requiredHeaders: { ...zoko.requiredHeaders },
          subtitle_mode: zoko.subtitleMode,
          subtitles: zoko.subtitles.map((track, index) => ({
            id: `zoko-sub-${index}`,
            label: track.label || track.lang || `Subtítulo ${index + 1}`,
            language: track.lang || "en",
            src: track.src,
            is_default: track.default === true,
          })),
        };
      }
    }

    if (isMegaplayUrl(rawUrl)) {
      const megaplay = await resolveMegaplay(rawUrl);
      if (megaplay.url && !this.isPlaceholderUrl(megaplay.url)) {
        return {
          url: megaplay.url,
          original_url: rawUrl,
          canonical_locator: rawUrl,
          resolved: true,
          type: "direct",
          provider: "Megaplay (AniPulse)",
          delivery_mode: "direct_trial",
          is_proxyable: true,
          is_refreshable: true,
          requiredHeaders: { ...megaplay.requiredHeaders },
          subtitles: megaplay.subtitles.map((track, index) => ({
            id: `megaplay-sub-${index}`,
            label: track.label || track.lang || `Subtítulo ${index + 1}`,
            language: track.lang || "en",
            src: track.src,
            is_default: track.default === true,
          })),
        };
      }
    }

    if (isHianimesWatchUrl(rawUrl)) {
      const hianimes = await this.resolveHianimesWatchMeta(rawUrl);
      if (hianimes) {
        return {
          url: hianimes.url,
          original_url: rawUrl,
          canonical_locator: rawUrl,
          resolved: true,
          type: "direct",
          provider,
          delivery_mode: "direct_trial",
          is_proxyable: true,
          is_refreshable: true,
          ...(hianimes.requiredHeaders ? { requiredHeaders: hianimes.requiredHeaders } : {}),
          ...(hianimes.subtitle_mode ? { subtitle_mode: hianimes.subtitle_mode } : {}),
          ...(hianimes.subtitles ? { subtitles: hianimes.subtitles } : {}),
        };
      }
    }

    if (rawUrl.includes("mega.nz/")) {
      const megaParsed = parseMegaUrl(rawUrl);
      if (megaParsed && megaParsed.kind === "file") {
        return {
          url: `/api/v1/stream/mega?url=${encodeURIComponent(megaParsed.canonicalUrl)}`,
          original_url: rawUrl,
          canonical_locator: rawUrl,
          resolved: true,
          type: "direct",
          provider: "Mega",
          delivery_mode: "direct_trial",
          is_proxyable: true,
          is_refreshable: false,
        };
      }
    }

    const resolvedUrl = await this.resolve(rawUrl);
    let isDirect = this.isDirectMediaUrl(resolvedUrl) && !this.isPlaceholderUrl(resolvedUrl);
    let finalUrl = resolvedUrl;
    let finalHeaders: Record<string, string> | undefined;

    const resolvedExpiry = isDirect ? parseStreamExpiry(finalUrl).expiresAt : undefined;
    if (isDirect && resolvedExpiry !== undefined && resolvedExpiry <= Date.now()) {
      return {
        url: rawUrl,
        original_url: rawUrl,
        canonical_locator: rawUrl,
        resolved: false,
        type: "embed",
        provider,
        is_proxyable: false,
        is_refreshable: true,
        failure_reason: "unresolved",
      };
    }

    return {
      url: finalUrl,
      original_url: rawUrl,
      resolved: isDirect,
      type: isDirect ? "direct" : "embed",
      provider,
      ...(isDirect
        ? {
            is_proxyable: true,
            is_refreshable: true,
            canonical_locator: rawUrl,
            delivery_mode: "direct_trial" as const,
          }
        : {
            is_proxyable: false,
            is_refreshable: false,
            failure_reason: "unresolved" as const,
          }),
      ...(finalHeaders ? { requiredHeaders: finalHeaders } : {}),
      ...(provider === "Vimeos" ? { requiredHeaders: { ...VIMEOS_REQUIRED_HEADERS } } : {}),
      ...(isZokoCdnUrl(finalUrl) ? { requiredHeaders: { ...ZOKO_REQUIRED_HEADERS } } : {}),
    };
  }

  /**
   * Resuelve la URL real directa (.m3u8 / .mp4) a partir de una URL de iframe/embed.
   * Si no se puede desofuscar a stream directo, devuelve la URL de embed sanitizada (ej. mega /embed).
   */
  public static async resolve(iframeUrl: string): Promise<string> {
    const rawUrl = (iframeUrl || "").trim();
    if (!rawUrl) return "";

    // HiAnimes watch pages are stable canonical locators. Resolve their episode
    // API just-in-time and then reuse the regular provider resolvers (Zoko first).
    if (isHianimesWatchUrl(rawUrl)) {
      const hianimesStream = await this.resolveHianimesWatch(rawUrl);
      if (hianimesStream) return hianimesStream;
      return rawUrl;
    }

    // ZokoAnime exposes a small XOR/base64 payload containing its HLS master.
    if (isZokoAnimeUrl(rawUrl)) {
      const zoko = await resolveZokoAnime(rawUrl);
      if (zoko.url && !this.isPlaceholderUrl(zoko.url)) return zoko.url;
    }

    if (isMegaplayUrl(rawUrl)) {
      const megaplay = await resolveMegaplay(rawUrl);
      if (megaplay.url && !this.isPlaceholderUrl(megaplay.url)) return megaplay.url;
    }

    // 1. MEGA.NZ: Convertir /file/ a /embed/ para evitar que redirija a la web de Mega
    if (rawUrl.includes("mega.nz/file/")) {
      return rawUrl.replace("mega.nz/file/", "mega.nz/embed/");
    }
    if (rawUrl.includes("mega.nz/embed/")) {
      return rawUrl;
    }

    // 2. VIMEOS.NET: master.m3u8 directo vía desempaquetado/GET validado.
    // Nunca devolver /d/{id}_h: es una página HTML de descarga no jugable.
    if (VimeosResolver.isVimeosUrl(rawUrl)) {
      const streams = await VimeosResolver.resolveVimeos(rawUrl);
      if (streams.length > 0 && !this.isPlaceholderUrl(streams[0])) return streams[0];
      return rawUrl;
    }

    // 3. MP4UPLOAD: Desempaquetar JS de mp4upload para obtener .mp4 directo
    if (rawUrl.includes("mp4upload.com")) {
      const mp4Direct = await this.resolveMp4Upload(rawUrl);
      if (mp4Direct) return mp4Direct;
    }

    // 4. YOURUPLOAD: Extraer enlace .mp4 directo
    if (rawUrl.includes("yourupload.com") || rawUrl.includes("playmudos.com")) {
      const yuDirect = await this.resolveYourUpload(rawUrl);
      if (yuDirect) return yuDirect;
    }

    // 5. OK.RU / OKRU: Extraer stream de video
    if (rawUrl.includes("ok.ru")) {
      const okDirect = await this.resolveOkru(rawUrl);
      if (okDirect) return okDirect;
    }

    // 6. VOE.SX / BYSELAPUIX: Extraer .m3u8 directo
    if (rawUrl.includes("voe.sx") || rawUrl.includes("byselapuix.com") || rawUrl.includes("voe.")) {
      const voeDirect = await this.resolveVoe(rawUrl);
      if (voeDirect) return voeDirect;
    }

    // 6a. PRIMELOAD.CO: Extraer .m3u8 maestro desde la API interna /api/v1/player/{code}
    if (rawUrl.includes("primeload.co")) {
      const primeDirect = await this.resolvePrimeload(rawUrl);
      if (primeDirect) return primeDirect;
    }

    // 6b. BYSE (SPA con playback cifrado AES-GCM, ej. byseqekaho.com): la página /e/{code}
    // es un shell React vacío; el m3u8 firmado vive en /api/videos/{code}/ dentro de
    // playback.payload, descifrable con key_parts + version (lógica pública del player).
    if (this.isByseHost(rawUrl)) {
      const byseDirect = await this.resolveByse(rawUrl);
      if (byseDirect) return byseDirect;
    }

    // 6c. HEXLOAD / BYSEKOZE: hosts oscuros de latanime. Extracción fetch+cheerio con
    // unpack Dean Edwards; si la ofuscación es indescifrable devuelven el propio embed
    // (fallback inteligente a iframe, nunca lanzan).
    if (rawUrl.includes("hexload")) {
      const hexload = await resolveHexload(rawUrl);
      if (hexload.type === "direct") return hexload.url;
      return rawUrl;
    }

    // 6d. BYSESUKIOR.COM: variante del ecosistema Byse (SPA React con playback
    // AES-GCM). El .mp4/.m3u8 firmado vive en /api/videos/{code}/ dentro de
    // playback.payload, descifrable con key_parts + version. Cuando es el único
    // servidor disponible, lo desofuscamos para entregar media nativo al frontend.
    if (this.isBysesukiorHost(rawUrl)) {
      const bs = await this.resolveBysesukior(rawUrl);
      if (bs) return bs;
    }

    // 7. STREAMTAPE: Extraer token y enlace directo
    if (rawUrl.includes("streamtape.com") || rawUrl.includes("streamtape.to")) {
      const streamtapeDirect = await this.resolveStreamtape(rawUrl);
      if (streamtapeDirect) return streamtapeDirect;
    }

    // 8. STREAMWISH / FILEMOON / VIDMOLY / UPSTREAM / FASTRE / STREAMHIDE
    if (
      rawUrl.includes("streamwish") ||
      rawUrl.includes("wishonly") ||
      rawUrl.includes("sfastwish") ||
      rawUrl.includes("flaswish") ||
      rawUrl.includes("hlswish") ||
      rawUrl.includes("premilkyway") ||
      rawUrl.includes("filemoon") ||
      rawUrl.includes("vidmoly") ||
      rawUrl.includes("upstream") ||
      rawUrl.includes("fastre") ||
      rawUrl.includes("streamhide") ||
      rawUrl.includes("swhoi")
    ) {
      const unpacked = await this.resolvePackedEmbed(rawUrl);
      if (unpacked) return unpacked;
    }

    // 9. DOODSTREAM (tier 2): pass_md5.sh → MP4 directo con token; fallback iframe
    if (rawUrl.includes("dood.") || rawUrl.includes("doodstream") || rawUrl.includes("dsvplay") || rawUrl.includes("d000d") || rawUrl.includes("ds2play") || rawUrl.includes("do7go")) {
      const dood = await resolveDoodstream(rawUrl);
      if (dood.type === "direct") return dood.url;
      return rawUrl;
    }

    // 10. UQLOAD (tier 1): JS packed del embed → MP4 directo; fallback iframe
    if (rawUrl.includes("uqload")) {
      const uq = await resolveUqload(rawUrl);
      if (uq.type === "direct") return uq.url;
      return rawUrl;
    }

    // 11. VIDHIDE (tier 3): packed jwplayer → m3u8/mp4 directo; fallback iframe
    if (
      rawUrl.includes("vidhide") ||
      rawUrl.includes("vixhide") ||
      rawUrl.includes("dramiyos-cdn") ||
      rawUrl.includes("vidhideplus") ||
      rawUrl.includes("vidhidevip")
    ) {
      const vh = await resolveVidhide(rawUrl);
      if (vh.type === "direct") return vh.url;
      return rawUrl;
    }

    // 11b. HQQ.AC / DIVXPLAYER (reproductor embed de VerAnimes): el m3u8 va
    // incrustado en el HTML del player (og:video / var). Se extrae con regex
    // directo; si el video está protegido por captcha (need_captcha=1) el HTML
    // trae un m3u8 placeholder → se descarta y se devuelve el embed como fallback.
    if (rawUrl.includes("hqq.") || rawUrl.includes("waaw") || rawUrl.includes("divxplayer") || rawUrl.includes("cvary.org")) {
      const hqq = await this.resolveHqq(rawUrl);
      if (hqq) return hqq;
    }

    // 12. GOODSTREAM: el m3u8 firmado vive en el HTML del embed (jwplayer setup en texto plano).
    // El embed de goodstream.one/embed-{code}.html responde con el script del player que
    // incluye la URL de enc{N}.goodstream.one/hls2/...master.m3u8 sin ofuscar.
    // Requiere Referer=goodstream.one para que Cloudflare sirva el HTML real.
    if (rawUrl.includes("goodstream.")) {
      const gs = await this.resolveGoodstream(rawUrl);
      if (gs) return gs;
      return rawUrl; // fallback: dejar el embed (navegador lo carga con Referer correcto)
    }

    // 13. Genérico: intentar extraer .m3u8 o .mp4 del HTML del iframe
    const generic = await this.resolveGeneric(rawUrl);
    return generic || rawUrl;
  }

  private static async resolveHianimesWatch(rawUrl: string): Promise<string | null> {
    const slug = hianimesSlugFromUrl(rawUrl) || "";
    if (!slug) return null;
    const { episode } = await fetchHianimesEpisode(slug);
    if (!episode) return null;
    for (const link of episodeLinks(episode)) {
      const resolved = link.url.includes("zokoanime.video")
        ? (await resolveZokoAnime(link.url)).url
        : await this.resolve(link.url);
      if (resolved && resolved !== link.url && this.isDirectMediaUrl(resolved) && !this.isPlaceholderUrl(resolved)) return resolved;
    }
    return null;
  }

  private static async resolveHianimesWatchMeta(rawUrl: string): Promise<{
    url: string;
    subtitles?: ResolvedStreamMeta["subtitles"];
    subtitle_mode?: ResolvedStreamMeta["subtitle_mode"];
    requiredHeaders?: Record<string, string>;
  } | null> {
    const slug = hianimesSlugFromUrl(rawUrl) || "";
    if (!slug) return null;
    const { episode } = await fetchHianimesEpisode(slug);
    if (!episode) return null;
    for (const link of episodeLinks(episode)) {
      if (isZokoAnimeUrl(link.url)) {
        const zoko = await resolveZokoAnime(link.url);
        if (!zoko.url || this.isPlaceholderUrl(zoko.url)) continue;
        return {
          url: zoko.url,
          requiredHeaders: { ...zoko.requiredHeaders },
          subtitle_mode: zoko.subtitleMode,
          subtitles: zoko.subtitles.map((track, index) => ({
            id: `zoko-sub-${index}`,
            label: track.label || track.lang || `Subtítulo ${index + 1}`,
            language: track.lang || "en",
            src: track.src,
            is_default: track.default === true,
          })),
        };
      }
      const resolved = await this.resolve(link.url);
      if (resolved && resolved !== link.url && this.isDirectMediaUrl(resolved) && !this.isPlaceholderUrl(resolved)) {
        return { url: resolved };
      }
    }
    return null;
  }


  /**
   * Resuelve el embed de hqq.ac / divxplayer (reproductor "raro" de VerAnimes).
   * El m3u8 maestro va directamente en el HTML del /e/{id}, en:
   *   - meta og:video / og:video:url
   *   - atributos data-* / var del player
   * Descarta m3u8 placeholder (el reproductor sirve el mismo video de demo
   * "TenchiMuyo_18" cuando el video real está tras captcha).
   */
  private static async resolveHqq(url: string): Promise<string | null> {
    try {
      const html = await this.fetchHtml(url);
      if (!html) return null;

      // Si requiere captcha, no hay m3u8 real alcanzable server-side.
      if (/need_captcha\s*=\s*1/i.test(html)) return null;

      const m3u8Regex = /https?:\/\/[^\s"'<>\\]+\.(?:mp4\.)?m3u8(?:\?[^\s"'<>\\]*)?/gi;
      const matches = html.match(m3u8Regex) || [];
      const urls = matches.map((m) => m.replace(/\\/g, "").replace(/["']/g, ""));
      if (urls.length === 0) return null;

      // Filtrar placeholders (video demo genérico del player)
      const real = urls.filter((u) => !u.includes("153311550983uua") && !u.includes("cfglobalcdn.com"));
      return real.length > 0 ? real[0] : null;
    } catch {
      return null;
    }
  }

  /**
   * Resuelve stream directo de MP4Upload
   */
  private static async resolveMp4Upload(url: string): Promise<string | null> {
    try {
      const html = await this.fetchHtml(url);
      if (!html) return null;

      // Buscar script empaquetado
      const unpacked = unpackGeneric(html);
      const match =
        unpacked.match(/src:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i) ||
        unpacked.match(/["'](https?:\/\/[a-zA-Z0-9.\-_:]+\/d\/[^"']+\/video\.mp4)["']/i);
      if (match) return match[1];

      const direct = extractMediaUrlsFromCode(unpacked);
      return direct.find((u) => u.includes(".mp4")) || null;
    } catch {
      return null;
    }
  }

  /**
   * Resuelve stream directo de YourUpload
   */
  private static async resolveYourUpload(url: string): Promise<string | null> {
    try {
      const html = await this.fetchHtml(url);
      if (!html) return null;

      const match =
        html.match(/file:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i) ||
        html.match(/<meta\s+property=["']og:video["']\s+content=["']([^"']+)["']/i) ||
        html.match(/<source\s+src=["']([^"']+\.mp4[^"']*)["']/i);

      if (match) return match[1];

      const unpacked = unpackGeneric(html);
      const matchUnpacked = unpacked.match(/file:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
      if (matchUnpacked) return matchUnpacked[1];

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Resuelve stream de OK.RU
   */
  private static async resolveOkru(url: string): Promise<string | null> {
    try {
      const html = await this.fetchHtml(url);
      if (!html) return null;

      // Detectar videos bloqueados por copyright o restricciones
      if (
        html.includes("Access to this video is restricted") ||
        html.includes("not available") ||
        html.includes("copyrights") ||
        html.includes("restricted")
      ) {
        return null;
      }

      // OK.RU incluye JSON en data-options o hlsManifestUrl
      const hlsMatch = html.match(/hlsManifestUrl["']?\s*:\s*["']([^"']+)["']/i) ||
                       html.match(/data-options=["']([^"']+)["']/i);

      if (hlsMatch) {
        const val = hlsMatch[1].replace(/&quot;/g, '"').replace(/\\"/g, '"').replace(/\\\//g, "/");
        if (val.includes(".m3u8")) {
          const directMatch = val.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);
          if (directMatch) return directMatch[0];
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Resuelve stream directo de VOE / ByseLapuix
   */
  private static async resolveVoe(url: string): Promise<string | null> {
    try {
      const html = await this.fetchHtml(url);
      if (!html) return null;

      // 1. Direct regex match
      const hlsMatch =
        html.match(/['"]hls['"]\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i) ||
        html.match(/['"](https?:\/\/[^'"]+\.m3u8(?:\?[^'"]*)?)['"]/i);
      if (hlsMatch) return hlsMatch[1];

      // 2. Caso Base64 en VOE
      const b64Match =
        html.match(/prompt\(['"][^'"]*['"],\s*['"]([A-Za-z0-9+/=]{20,})['"]\)/) ||
        html.match(/sources\s*=\s*JSON\.parse\(atob\(['"]([A-Za-z0-9+/=]+)['"]\)\)/) ||
        html.match(/atob\(['"]([A-Za-z0-9+/=]{20,})['"]\)/);

      if (b64Match) {
        try {
          const decoded = Buffer.from(b64Match[1], "base64").toString("utf-8");
          const media = extractMediaUrlsFromCode(decoded);
          if (media.length > 0) return media[0];
        } catch {}
      }

      // 3. Caso redirect JS a dominio rotativo (ej. window.location.href = '...')
      const redirectMatch = html.match(/window\.location\.href\s*=\s*['"](https?:\/\/[^'"]+)['"]/i);
      if (redirectMatch && redirectMatch[1] !== url) {
        const nextHtml = await this.fetchHtml(redirectMatch[1]);
        if (nextHtml) {
          const nextHls = nextHtml.match(/['"](https?:\/\/[^'"]+\.m3u8(?:\?[^'"]*)?)['"]/i);
          if (nextHls) return nextHls[1];
        }
      }

      const unpacked = unpackGeneric(html);
      const media = extractMediaUrlsFromCode(unpacked);
      return media.find((u) => u.includes(".m3u8")) || media[0] || null;
    } catch {
      return null;
    }
  }

  /**
   * Resuelve stream directo de Streamtape
   */
  private static async resolveStreamtape(url: string): Promise<string | null> {
    try {
      const html = await this.fetchHtml(url);
      if (!html) return null;

      // Streamtape concatena robotlink: document.getElementById('robotlink').innerHTML = '//streamtape.com/get_video?id=...' + ('&token=...');
      const matchRobot = html.match(
        /document\.getElementById\(['"](?:robotlink|videolink)['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*['"]([^'"]+)['"]/i
      );
      if (matchRobot) {
        let streamUrl = matchRobot[1] + matchRobot[2];
        if (streamUrl.startsWith("//")) streamUrl = `https:${streamUrl}`;
        return streamUrl;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Resuelve reproductor de Primeload.co a su .m3u8 maestro vía /api/v1/player/{code}
   */
  private static async resolvePrimeload(url: string): Promise<string | null> {
    try {
      const codeMatch = url.match(/\/embed\/([a-zA-Z0-9_-]+)/);
      if (!codeMatch) return null;
      const code = codeMatch[1];
      const apiUrl = `https://primeload.co/api/v1/player/${code}`;
      const jsonText = await this.fetchHtml(apiUrl);
      if (!jsonText) return null;
      const data = JSON.parse(jsonText);
      return data.master_manifest || data.sources?.[0]?.src || null;
    } catch {
      return null;
    }
  }

  /**
   * Detecta hosts del ecosistema "Byse" (SPA React con playback AES-GCM).
   * El título de su HTML es "Byse Frontend" y sirve /assets/index-*.js.
   * bysekoze.com verificado 2026-08-23: misma SPA y misma /api/videos/{code}/.
   */
  private static isByseHost(url: string): boolean {
    return /byse[a-z0-9-]*\.[a-z]+/i.test(url);
  }

  /**
   * Resuelve streams de backends Byse:
   * 1. GET {origin}/api/videos/{code}/ → JSON con playback {algorithm, iv, payload, key_parts, version}
   * 2. key = concat(base64url(key_parts[i])) según permutación de `version` (N^0, 31-N^0)
   * 3. AES-256-GCM decrypt (tag = últimos 16 bytes) → JSON con sources[].url (.m3u8 firmado)
   */
  private static async resolveByse(url: string): Promise<string | null> {
    try {
      const match = url.match(/\/e\/([a-zA-Z0-9]+)/i);
      if (!match) return null;

      const origin = new URL(url).origin;
      const apiUrl = `${origin}/api/videos/${match[1]}/`;
      const json = await this.fetchHtml(apiUrl);
      if (!json) return null;

      const data = JSON.parse(json) as {
        playback?: {
          algorithm?: string;
          iv: string;
          payload: string;
          key_parts?: string[];
          version?: string | number;
        };
      };
      const pb = data.playback;
      if (!pb || pb.algorithm !== "AES-256-GCM" || !Array.isArray(pb.key_parts)) return null;

      const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

      // Permutación pública del player: version N → [N ^ 0, 31 - N ^ 0] (1-based)
      const v = parseInt(String(pb.version ?? ""), 10);
      const parts = Number.isInteger(v) ? [v ^ 0, 31 - (v ^ 0)] : [];
      const keyParts = Array.isArray(pb.key_parts) ? pb.key_parts : [];
      if (keyParts.length === 0) return null;
      const picked = parts
        .filter((i) => i >= 1 && i <= keyParts.length)
        .map((i) => keyParts[i - 1])
        .filter((s): s is string => typeof s === "string" && s.length > 0);
      const keyStr = picked.length > 0 ? picked : keyParts;

      const key = Buffer.concat(keyStr.map(b64url));
      const iv = b64url(pb.iv);
      const full = b64url(pb.payload);
      const tag = full.subarray(full.length - 16);
      const body = full.subarray(0, full.length - 16);

      const dec = crypto.createDecipheriv("aes-256-gcm", key, iv);
      dec.setAuthTag(tag);
      const plain = Buffer.concat([dec.update(body), dec.final()]).toString("utf8");
      const inner = JSON.parse(plain) as { sources?: Array<{ url?: string }> };

      const m3u8 = (inner.sources || []).map((s) => s.url || "").find((u) => u.startsWith("http") && u.includes(".m3u8"));
      return m3u8 || null;
    } catch {
      return null;
    }
  }

  /**
   * Detecta bysesukior.com (variante Byse con playback cifrado, sirve .mp4 firmado).
   */
  private static isBysesukiorHost(url: string): boolean {
    return /bysesukior\.com/i.test(url);
  }

  /**
   * Desofusca bysesukior.com /e/{code} a su .mp4/.m3u8 real:
   * 1. GET {origin}/api/videos/{code}/ → JSON con playback {algorithm, iv, payload, key_parts, version}
   * 2. key = concat(base64url(key_parts[i])) según permutación de `version` (N^0, 31-N^0)
   * 3. AES-256-GCM decrypt (tag = últimos 16 bytes) → JSON con sources[].url
   * Si el backend no responde al patrón Byse, cae al extractor genérico de .mp4.
   */
  private static async resolveBysesukior(url: string): Promise<string | null> {
    try {
      const match = url.match(/\/e\/([a-zA-Z0-9]+)/i);
      if (!match) return null;

      const origin = new URL(url).origin;
      const apiUrl = `${origin}/api/videos/${match[1]}/`;
      const json = await this.fetchHtml(apiUrl);
      if (!json) return await this.resolveGeneric(url);

      const data = JSON.parse(json) as {
        playback?: {
          algorithm?: string;
          iv: string;
          payload: string;
          key_parts?: string[];
          version?: string | number;
        };
      };
      const pb = data.playback;
      if (!pb || pb.algorithm !== "AES-256-GCM" || !Array.isArray(pb.key_parts)) {
        return await this.resolveGeneric(url);
      }

      const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

      const v = parseInt(String(pb.version ?? ""), 10);
      const parts = Number.isInteger(v) ? [v ^ 0, 31 - (v ^ 0)] : [];
      const keyParts = pb.key_parts;
      const picked = parts
        .filter((i) => i >= 1 && i <= keyParts.length)
        .map((i) => keyParts[i - 1])
        .filter((s): s is string => typeof s === "string" && s.length > 0);
      const keyStr = picked.length > 0 ? picked : keyParts;

      const key = Buffer.concat(keyStr.map(b64url));
      const iv = b64url(pb.iv);
      const full = b64url(pb.payload);
      const tag = full.subarray(full.length - 16);
      const body = full.subarray(0, full.length - 16);

      const dec = crypto.createDecipheriv("aes-256-gcm", key, iv);
      dec.setAuthTag(tag);
      const plain = Buffer.concat([dec.update(body), dec.final()]).toString("utf8");
      const inner = JSON.parse(plain) as { sources?: Array<{ url?: string }> };

      const media = (inner.sources || [])
        .map((s) => s.url || "")
        .find((u) => u.startsWith("http") && (u.includes(".mp4") || u.includes(".m3u8")));
      return media || await this.resolveGeneric(url);
    } catch {
      return null;
    }
  }

  /**
   * Resuelve reproductores con scripts empaquetados tipo Dean Edwards
   */
  private static async resolvePackedEmbed(url: string): Promise<string | null> {
    try {
      const html = await this.fetchHtml(url);
      if (!html) return null;

      const unpacked = unpackGeneric(html);
      const mediaUrls = extractMediaUrlsFromCode(unpacked);
      const m3u8 = mediaUrls.find((u) => u.includes(".m3u8"));
      if (m3u8) return m3u8;

      const mp4 = mediaUrls.find((u) => u.includes(".mp4"));
      if (mp4) return mp4;

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Resuelve Goodstream: el m3u8 firmado está embebido directamente en el HTML del embed.
   * El script de jwplayer contiene la URL enc{N}.goodstream.one/hls2/.../master.m3u8?t=...
   * en texto plano dentro de la etiqueta <script>. Sin ofuscación.
   * Requiere Referer=goodstream.one para que Cloudflare entregue el HTML real.
   */
  private static async resolveGoodstream(url: string): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.DEFAULT_TIMEOUT);
      let html: string | null = null;
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent": this.DEFAULT_HEADERS["User-Agent"],
            "Referer": "https://goodstream.one/",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
          },
        });
        clearTimeout(timer);
        if (!res.ok) return null;
        html = await res.text();
      } catch {
        clearTimeout(timer);
        return null;
      }

      if (!html || html.includes("File is no longer available") || html.includes("expired or has been deleted")) {
        return null;
      }

      // El m3u8 firmado está en texto plano en el objeto de configuración del jwplayer.
      // Preferir master.m3u8 (contiene todas las calidades) sobre playlists de nivel (_l/index...).
      const m3u8Regex = /https?:\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]*)?/gi;
      const matches = html.match(m3u8Regex) || [];
      const cleaned = matches
        .map((m) => m.replace(/\\/g, "").replace(/['"]/g, ""))
        .filter((m) => m.includes("goodstream") || m.includes(".goodstream."));
      // Priorizar el master.m3u8 (urlset) que contiene todas las calidades
      const master = cleaned.find((m) => m.includes("master.m3u8") || m.includes(".urlset/"));
      return master || cleaned[0] || null;
    } catch {
      return null;
    }
  }

  /**
   * Fallback genérico para iframes
   */
  private static async resolveGeneric(url: string): Promise<string | null> {
    try {
      const html = await this.fetchHtml(url);
      if (!html) return null;

      const unpacked = unpackGeneric(html);
      const mediaUrls = extractMediaUrlsFromCode(unpacked);
      return mediaUrls[0] || null;
    } catch {
      return null;
    }
  }

  private static async fetchHtml(url: string): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.DEFAULT_TIMEOUT);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          ...this.DEFAULT_HEADERS,
          Referer: new URL(url).origin + "/",
        },
      });
      clearTimeout(timer);

      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }
}

// ── Registro Modular de Resolvers por Proveedor ──────────────────────────────

async function isVidSrcManifestUsable(
  hlsUrl: string | undefined,
  requiredHeaders: Record<string, string> | undefined,
): Promise<boolean> {
  if (!hlsUrl) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  try {
    const response = await fetch(hlsUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "*/*",
        ...(requiredHeaders || {}),
      },
    });
    if (response.status !== 200) return false;
    const manifest = await response.text();
    if (!manifest.includes("#EXTM3U")) return false;

    // A VidSrc mirror can return a healthy master/child playlist while its
    // first media resource is already an image/HTML placeholder. Probe one
    // segment before accepting the mirror so the player does not announce a
    // false direct source and immediately cascade through every fallback.
    const mediaLine = (text: string): string | undefined => text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#"));
    const child = mediaLine(manifest);
    if (!child) return true;
    const childUrl = new URL(child, response.url || hlsUrl).toString();
    const childResponse = await fetch(childUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: { Accept: "*/*", ...(requiredHeaders || {}) },
    });
    if (childResponse.status !== 200) return false;
    const childText = await childResponse.text();
    const segment = mediaLine(childText);
    if (!segment) return true;
    const segmentResponse = await fetch(new URL(segment, childResponse.url || childUrl), {
      redirect: "follow",
      signal: controller.signal,
      headers: { Accept: "*/*", Range: "bytes=0-1023", ...(requiredHeaders || {}) },
    });
    if (segmentResponse.status < 200 || segmentResponse.status >= 300) return false;
    const bytes = new Uint8Array(await segmentResponse.arrayBuffer()).subarray(0, 16);
    if (bytes.length === 0) return false;
    // Reject common poster/error bodies while allowing MPEG-TS, fMP4, AAC and
    // providers that mislabel valid bytes as text/html.
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = png.every((value, index) => bytes[index] === value);
    const textPrefix = new TextDecoder().decode(bytes).trimStart().toLowerCase();
    return !jpeg && !isPng && !textPrefix.startsWith("<html") && !textPrefix.startsWith("<!doctype");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveVidSrcLocator(locator: string): Promise<ResolvedStreamMeta> {
  let lastResult: Awaited<ReturnType<typeof resolveVidSrcEmbed>> | undefined;
  for (const mirrorUrl of buildVidSrcMirrorUrls(locator)) {
    const result = await resolveVidSrcEmbed(mirrorUrl);
    lastResult = result;
    const resolved = result.status === "direct" && Boolean(result.hlsUrl);
    if (!resolved || !(await isVidSrcManifestUsable(result.hlsUrl, result.requiredHeaders))) continue;

    return {
      url: result.hlsUrl!,
      original_url: locator,
      canonical_locator: result.embedUrl || mirrorUrl,
      resolved: true,
      type: "direct",
      provider: "vidsrc",
      requiredHeaders: result.requiredHeaders,
      ...(result.audioTracks?.length ? {
        audio_tracks: result.audioTracks.map((track) => ({
          id: track.id,
          label: track.label,
          language: track.language,
          url: track.url,
          is_default: track.isDefault,
        })),
      } : {}),
      ...(result.subtitles?.length ? {
        subtitles: result.subtitles.map((track, index) => ({
          id: `vidsrc-sub-${index}`,
          label: track.label || track.language || `Subtítulo ${index + 1}`,
          language: track.language || "und",
          src: track.url,
          is_default: false,
        })),
      } : {}),
      is_proxyable: true,
      is_refreshable: true,
      ...(result.requiredHeaders ? { delivery_mode: "proxy_required" as const } : {}),
    };
  }

  const failure = lastResult?.status === "blocked" ? "provider_blocked" as const : "unresolved" as const;
  return {
    url: locator,
    original_url: locator,
    canonical_locator: lastResult?.embedUrl || locator,
    resolved: false,
    type: "embed",
    provider: "vidsrc",
    requiredHeaders: lastResult?.requiredHeaders,
    is_proxyable: false,
    is_refreshable: false,
    failure_reason: failure,
  };
}

export class ProviderResolverRegistry {
  private readonly resolvers: ProviderResolver[] = [];

  constructor() {
    this.registerDefaults();
  }

  public register(resolver: ProviderResolver): void {
    this.resolvers.push(resolver);
  }

  public getResolvers(): readonly ProviderResolver[] {
    return this.resolvers;
  }

  public findResolver(urlStr: string): ProviderResolver | undefined {
    try {
      const parsed = new URL(urlStr);
      return this.resolvers.find((r) => r.matches(parsed));
    } catch {
      return undefined;
    }
  }

  public async resolve(locator: string, context?: ResolveContext): Promise<ResolvedStreamMeta> {
    const raw = (locator || "").trim();
    if (!raw) {
      return {
        url: "",
        original_url: "",
        resolved: false,
        type: "embed",
        provider: "Desconocido",
        is_proxyable: false,
        is_refreshable: false,
        failure_reason: "empty_locator",
      };
    }

    const resolver = this.findResolver(raw);
    if (resolver) {
      return resolver.resolve(raw, context);
    }
    return EmbedResolvers.resolveWithMeta(raw);
  }

  private registerDefaults(): void {
    // VidSrc devuelve una URL HLS firmada que el navegador no puede consumir
    // directamente por CORS/headers. Registrar su locator estable aquí permite
    // que PlaybackSessionStore renueve y relaye el HLS server-side.
    this.register({
      name: "VidSrc",
      matches: (url) => /^(?:vidsrc(?:2|me)?|vidsrc-me|vidsrc-embed|vsrc)\.(?:ir|ru|su|me|to|sbs)$/i.test(
        url.hostname.replace(/^www\./i, ""),
      ),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: false,
        renewable: true,
        requiresHeaders: true,
      },
      resolve: (locator) => resolveVidSrcLocator(locator),
    });

    // 1. Direct Media (.m3u8, .mp4, .webm)
    this.register({
      name: "DirectMedia",
      matches: (url) => EmbedResolvers.isDirectMediaUrl(url.href) && !url.hostname.includes("mega.nz"),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: false,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });

    // 2. Mega Cloud
    this.register({
      name: "Mega",
      matches: (url) => /mega\.(?:nz|io|co\.nz)/i.test(url.hostname),
      capabilities: {
        supportsDirect: false,
        supportsProxy: false,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });

    // 3. Vimeos
    this.register({
      name: "Vimeos",
      matches: (url) => /vimeos\.[a-z]+/i.test(url.hostname) || /p\d+\.vimeos\.zip/i.test(url.hostname),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: true,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });

    // 3b. ZokoAnime: site-specific public player resolver. Keeping this entry
    // ahead of GenericHtml ensures registry callers receive HLS plus subtitles
    // instead of an iframe/page fallback.
    this.register({
      name: "ZokoAnime",
      matches: (url) => isZokoAnimeUrl(url.href),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: false,
        renewable: true,
        requiresHeaders: true,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });

    // 4. MP4Upload
    this.register({
      name: "MP4Upload",
      matches: (url) => /mp4upload\.com/i.test(url.hostname),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });

    // 5. YourUpload
    this.register({
      name: "YourUpload",
      matches: (url) => /yourupload\.com/i.test(url.hostname),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });

    // 6. Okru
    this.register({
      name: "Okru",
      matches: (url) => /ok\.ru/i.test(url.hostname),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });

    // 7. VOE / ByseLapuix
    this.register({
      name: "VOE",
      matches: (url) => /voe\.sx|voe\.|byselapuix\.com/i.test(url.hostname),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });

    // 8. Primeload
    this.register({
      name: "Primeload",
      matches: (url) => /primeload\.co/i.test(url.hostname),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });

    // 9. Byse Ecosistema
    this.register({
      name: "Byse",
      matches: (url) => /byseqekaho\.com|byselapuix\.com|bysekoze\.com/i.test(url.hostname),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });

    // 10. Bysesukior
    this.register({
      name: "Bysesukior",
      matches: (url) => /bysesukior\.com/i.test(url.hostname),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });

    // 11. Streamtape
    this.register({
      name: "Streamtape",
      matches: (url) => /streamtape\.(?:com|to)/i.test(url.hostname),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });

    // 12. DoodStream
    this.register({
      name: "Doodstream",
      matches: (url) => /dood\.|doodstream|dsvplay|d000d|ds2play|do7go/i.test(url.hostname),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });

    // 13. Uqload
    this.register({
      name: "Uqload",
      matches: (url) => /uqload/i.test(url.hostname),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });

    // 14. Vidhide
    this.register({
      name: "Vidhide",
      matches: (url) => /vidhide|vixhide/i.test(url.hostname),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });

    // 15. HQQ / Divxplayer
    this.register({
      name: "Netu/HQQ",
      matches: (url) => /hqq\.|waaw|divxplayer|cvary\.org/i.test(url.hostname),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });

    // 16. Goodstream
    this.register({
      name: "Goodstream",
      matches: (url) => /goodstream\./i.test(url.hostname),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: true,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });

    // 17. Generic Packed (Streamwish, Filemoon, Vidmoly, etc.)
    this.register({
      name: "PackedEmbed",
      matches: (url) => /streamwish|filemoon|vidmoly|upstream|fastre|streamhide|swhoi/i.test(url.hostname),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });

    // 18. LaMovie Platform Pages
    this.register({
      name: "LaMovie",
      matches: (url) => isLaMoviePageUrl(url),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => resolveLaMoviePage(locator),
    });

    // 19. CineCalidad Platform Pages
    this.register({
      name: "Cinecalidad",
      matches: (url) => isCinecalidadPageUrl(url),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => resolveCinecalidadPage(locator),
    });

    // 20. TioPlus Platform Pages
    this.register({
      name: "TioPlus",
      matches: (url) => isTioPlusPageUrl(url),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => resolveTioPlusPage(locator),
    });

    // 21. AnimeFLV Platform Pages
    this.register({
      name: "AnimeFLV",
      matches: (url) => isAnimeFlvPageUrl(url),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => resolveAnimeFlvPage(locator),
    });

    // 22. JKanime Platform Pages
    this.register({
      name: "JKanime",
      matches: (url) => isJkanimePageUrl(url),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => resolveJkanimePage(locator),
    });

    // 23. LatAnime Platform Pages
    this.register({
      name: "LatAnime",
      matches: (url) => isLatAnimePageUrl(url),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => resolveLatAnimePage(locator),
    });

    // 24. Gnula Platform Pages
    this.register({
      name: "Gnula",
      matches: (url) => isGnulaPageUrl(url),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => resolveGnulaPage(locator),
    });

    // 25. TioAnime Platform Pages
    this.register({
      name: "TioAnime",
      matches: (url) => isTioAnimePageUrl(url),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => resolveTioAnimePage(locator),
    });

    // 26. VerAnimes Platform Pages
    this.register({
      name: "VerAnimes",
      matches: (url) => isVerAnimesPageUrl(url),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => resolveVerAnimesPage(locator),
    });

    // 27. Doramasflix Platform Pages
    this.register({
      name: "Doramasflix",
      matches: (url) => isDoramasflixPageUrl(url),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => resolveDoramasflixPage(locator),
    });

    // 28. TubePelis Platform Pages
    this.register({
      name: "TubePelis",
      matches: (url) => isTubePelisPageUrl(url),
      capabilities: {
        supportsDirect: true,
        supportsProxy: true,
        supportsEmbed: true,
        renewable: true,
        requiresHeaders: false,
      },
      resolve: async (locator) => resolveTubePelisPage(locator),
    });

    // 29. Generic Fallback
    this.register({
      name: "GenericHtml",
      matches: () => true,
      capabilities: {
        supportsDirect: false,
        supportsProxy: false,
        supportsEmbed: true,
        renewable: false,
        requiresHeaders: false,
      },
      resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator),
    });
  }
}

export const providerResolverRegistry = new ProviderResolverRegistry();
