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

// ── VimeosResolver: extractor del m3u8 maestro ──────────────────────────────
// Fetch al HTML del embed (https://vimeos.net/embed-xyz.html) + regex sobre el
// script de configuración del player (objeto sources, plano o Packed Dean Edwards).
// VIMEOS_REQUIRED_HEADERS se importa de hostProfiles.ts (fuente única por host).

const FETCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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

export interface ResolvedStreamMeta {
  url: string;
  original_url: string;
  resolved: boolean;
  type: "direct" | "embed";
  provider: string;
  /** Cabeceras que el nodo CDN exige al reproducir (403 sin ellas). */
  requiredHeaders?: Record<string, string>;
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
    return /\.(m3u8|mp4|webm)(\?|$)/i.test(u) || u.includes("/m3u8/") || u.includes("hls-vod");
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
    if (u.includes("mega.nz")) return "Mega";
    if (u.includes("mp4upload.com")) return "MP4Upload";
    if (u.includes("voe.sx") || u.includes("voe.") || u.includes("byselapuix")) return "VOE";
    if (u.includes("streamtape")) return "Streamtape";
    if (u.includes("yourupload.com")) return "YourUpload";
    if (u.includes("ok.ru")) return "Okru";
    if (u.includes("filemoon")) return "Filemoon";
    if (u.includes("streamwish") || u.includes("swhoi")) return "StreamWish";
    if (u.includes("vidmoly")) return "Vidmoly";
    if (u.includes("dood") || u.includes("do7go") || u.includes("ds2play")) return "DoodStream";
    // vimeos rota TLD en sus nodos (s{N}.vimeos.net, vimeos.zip, p{N}.vimeos.zip)
    if (/vimeos\.[a-z]+/i.test(u)) return "Vimeos";
    if (u.includes("mixdrop") || u.includes("mxdrop")) return "Mixdrop";
    if (u.includes("hqq.tv") || u.includes("waaw")) return "Netu/HQQ";
    if (u.includes("byseqekaho.com") || u.includes("byselapuix.com") || u.includes("bysekoze")) return "Bysekoze";
    if (u.includes("hexload")) return "Hexload";
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
      };
    }

    const provider = this.getProviderName(rawUrl);

    // Si ya es un stream directo, retornar inmediatamente (salvo placeholders del host)
    if (this.isDirectMediaUrl(rawUrl) && !this.isPlaceholderUrl(rawUrl)) {
      return {
        url: rawUrl,
        original_url: rawUrl,
        resolved: true,
        type: "direct",
        provider,
      };
    }

    const resolvedUrl = await this.resolve(rawUrl);
    const isDirect = this.isDirectMediaUrl(resolvedUrl) && !this.isPlaceholderUrl(resolvedUrl);

    return {
      url: resolvedUrl,
      original_url: rawUrl,
      resolved: isDirect,
      type: isDirect ? "direct" : "embed",
      provider,
      // Cubre tanto embeds como nodos del CDN (s{N}.vimeos.net, vimeos.zip):
      // los headers reales los aplica el proxy vía perfil de hostProfiles.
      ...(provider === "Vimeos" ? { requiredHeaders: { ...VIMEOS_REQUIRED_HEADERS } } : {}),
    };
  }

  /**
   * Resuelve la URL real directa (.m3u8 / .mp4) a partir de una URL de iframe/embed.
   * Si no se puede desofuscar a stream directo, devuelve la URL de embed sanitizada (ej. mega /embed).
   */
  public static async resolve(iframeUrl: string): Promise<string> {
    const rawUrl = (iframeUrl || "").trim();
    if (!rawUrl) return "";

    // 1. MEGA.NZ: Convertir /file/ a /embed/ para evitar que redirija a la web de Mega
    if (rawUrl.includes("mega.nz/file/")) {
      return rawUrl.replace("mega.nz/file/", "mega.nz/embed/");
    }
    if (rawUrl.includes("mega.nz/embed/")) {
      return rawUrl;
    }

    // 2. VIMEOS.NET: MP4 directo vía POST download_orig; fallback al propio embed
    // si falla (nunca devolver /d/{id}_h: es una página HTML de descarga no jugable)
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
    if (rawUrl.includes("yourupload.com")) {
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

    // 7. STREAMTAPE: Extraer token y enlace directo
    if (rawUrl.includes("streamtape.com") || rawUrl.includes("streamtape.to")) {
      const streamtapeDirect = await this.resolveStreamtape(rawUrl);
      if (streamtapeDirect) return streamtapeDirect;
    }

    // 8. STREAMWISH / FILEMOON / VIDMOLY / UPSTREAM / FASTRE / STREAMHIDE
    if (
      rawUrl.includes("streamwish") ||
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
    if (rawUrl.includes("vidhide") || rawUrl.includes("vixhide")) {
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

    // 12. Genérico: intentar extraer .m3u8 o .mp4 del HTML del iframe
    const generic = await this.resolveGeneric(rawUrl);
    return generic || rawUrl;
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
    return /byseqekaho\.com|byselapuix\.com|bysekoze\.com/i.test(url);
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
