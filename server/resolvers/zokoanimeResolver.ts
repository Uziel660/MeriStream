import { createDecipheriv, createHmac } from "node:crypto";

const ZOKO_HOST = "zokoanime.video";
const ZOKO_KEY = "otaku-embed-v1";
const DEFAULT_TIMEOUT_MS = 8_000;
const ZOKO_REFERER = "https://zokoanime.video/";
const MEGAPLAY_HOST = "megaplay.buzz";
const MEGAPLAY_AES_KEY = "i?LMTAx0Q6,:}50U";
const MEGAPLAY_AES_IV = "W0;27ToaUpl_P%'c";
const MEGAPLAY_TOKEN_KEY = "MpCdnT0k3n!9f2K#xQ7vL5mR8wN1pY4s";
const MEGAPLAY_TOKEN_TTL_SECONDS = 90;
const ZOKO_FETCH_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.8",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
} as const;

export const ZOKO_REQUIRED_HEADERS = {
  Referer: ZOKO_REFERER,
} as const;

type FetchLike = typeof fetch;

async function fetchWithAttemptTimeout(
  fetchImpl: FetchLike,
  input: string,
  init: RequestInit,
  options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function mirrorOrigin(host: string): string {
  return `https://${host}/`;
}

function requiredHeadersFor(host: string): Record<string, string> {
  return { Referer: mirrorOrigin(host) };
}

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(`${normalized}${"=".repeat(padding)}`, "base64");
}

function base64UrlEncode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function megaKey(value: string, length: number): Buffer {
  const result = Buffer.alloc(length);
  Buffer.from(value, "utf8").copy(result, 0, 0, length);
  return result;
}

function decryptMegaPlayPayload(encoded: string): Record<string, unknown> | null {
  try {
    const decipher = createDecipheriv("aes-256-cbc", megaKey(MEGAPLAY_AES_KEY, 32), megaKey(MEGAPLAY_AES_IV, 16));
    const plain = Buffer.concat([decipher.update(base64UrlDecode(encoded)), decipher.final()]).toString("utf8");
    const value: unknown = JSON.parse(plain);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function addMegaPlayCdnToken(rawUrl: string, nowMs = Date.now()): string {
  if (/[?&]token=/i.test(rawUrl)) return rawUrl;
  const match = rawUrl.match(/\/([a-f0-9]{32})\/([a-f0-9]{32})\//i);
  if (!match) return rawUrl;
  const expires = Math.floor(nowMs / 1000) + MEGAPLAY_TOKEN_TTL_SECONDS;
  const pathKey = `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
  const payload = `${expires}|${pathKey}`;
  const signature = createHmac("sha256", MEGAPLAY_TOKEN_KEY).update(payload).digest();
  const token = `${base64UrlEncode(Buffer.from(payload, "utf8"))}.${base64UrlEncode(signature)}`;
  return `${rawUrl}${rawUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

function mediaUrlFromPayload(payload: Record<string, unknown> | null): string | undefined {
  if (!payload) return undefined;
  const direct = [payload.file, payload.src, payload.url].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (direct) return direct.trim();
  const sources = payload.sources;
  if (Array.isArray(sources)) {
    for (const source of sources) {
      if (source && typeof source === "object") {
        const value = (source as Record<string, unknown>).file || (source as Record<string, unknown>).src || (source as Record<string, unknown>).url;
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
  } else if (sources && typeof sources === "object") {
    const value = (sources as Record<string, unknown>).file || (sources as Record<string, unknown>).src || (sources as Record<string, unknown>).url;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function isPlayableMediaUrl(value: string | undefined): value is string {
  return Boolean(value && /^https:\/\//i.test(value) && /(?:\.m3u8|\.mpd|\.mp4)(?:[?#]|$)/i.test(value));
}

export interface ZokoResolution {
  url: string;
  subtitles: Array<{ src: string; lang?: string; label?: string; default?: boolean }>;
  subtitleMode: "external" | "burned_in" | "unknown";
  title?: string;
  requiredHeaders: Record<string, string>;
}

export function isZokoAnimeUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    return host === ZOKO_HOST || host.endsWith(`.${ZOKO_HOST}`);
  } catch {
    return false;
  }
}

function decodePayload(blob: string): Record<string, unknown> | null {
  try {
    const bytes = Buffer.from(blob, "base64");
    const decoded = Buffer.alloc(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) {
      decoded[i] = bytes[i] ^ ZOKO_KEY.charCodeAt(i % ZOKO_KEY.length);
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(decoded));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function inferSubtitleLanguage(rawLanguage: string | undefined, label: string | undefined): string | undefined {
  const value = `${rawLanguage || ""} ${label || ""}`.toLowerCase();
  if (/spanish|espanol|español|castellano/.test(value)) return "es";
  if (/portuguese|brasil|brazil/.test(value)) return "pt";
  if (/french|français/.test(value)) return "fr";
  if (/italian|italiano/.test(value)) return "it";
  if (/german|deutsch/.test(value)) return "de";
  if (/arabic|العربية/.test(value)) return "ar";
  if (/russian|русский/.test(value)) return "ru";
  return rawLanguage;
}

function asSubtitles(value: unknown): ZokoResolution["subtitles"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const src = asString(item.src);
    if (!src || !/^https?:\/\//i.test(src)) return [];
    const label = asString(item.label);
    const lang = inferSubtitleLanguage(asString(item.lang), label);
    return [{
      src,
      lang,
      label,
      default: item.default === true,
    }];
  });
}

/**
 * Zoko's lightweight player keeps the actual HLS URL in an XOR/base64 payload
 * on the embed page. The operation is bounded and only accepts a public HTTPS
 * media URL; if the provider changes its recipe we return an empty result so
 * the caller can retain the canonical embed instead of persisting bad media.
 */
export async function resolveZokoAnime(
  embedUrl: string,
  options: { signal?: AbortSignal; timeoutMs?: number; fetch?: FetchLike } = {},
): Promise<ZokoResolution> {
  const fail = (): ZokoResolution => ({
    url: "",
    subtitles: [],
    subtitleMode: "unknown",
    requiredHeaders: { ...ZOKO_REQUIRED_HEADERS },
  });
  const cleanUrl = typeof embedUrl === "string" ? embedUrl.trim() : "";
  if (!cleanUrl || !isZokoAnimeUrl(cleanUrl)) return fail();

  const fetchImpl = options.fetch || globalThis.fetch;
  try {
    const mirrors = [ZOKO_HOST, MEGAPLAY_HOST];
    for (const host of mirrors) {
      const origin = mirrorOrigin(host);
      const locator = host === ZOKO_HOST
        ? cleanUrl
        : `${origin.replace(/\/$/, "")}${new URL(cleanUrl).pathname}`;
      const headers = {
        ...ZOKO_FETCH_HEADERS,
        Referer: origin,
      };
      let response: Response;
      try {
        response = await fetchWithAttemptTimeout(fetchImpl, locator, { headers }, options);
      } catch {
        continue;
      }
      if (!response.ok) continue;
      const html = await response.text();

      // Native Zoko pages expose an XOR/base64 payload directly.
      const token = html.match(/window\.__P\s*=\s*["']([^"']+)["']/i)?.[1];
      if (token) {
        const payload = decodePayload(token);
        const mediaUrl = asString(payload?.src);
        if (isPlayableMediaUrl(mediaUrl)) {
          const subtitles = asSubtitles(payload?.subtitles);
          return {
            url: mediaUrl,
            subtitles,
            subtitleMode: subtitles.length > 0
              ? "external"
              : /\/sub(?:[/?]|$)/i.test(cleanUrl) ? "burned_in" : "unknown",
            title: asString(payload?.title),
            requiredHeaders: requiredHeadersFor(host),
          };
        }
      }

      // MegaPlay exposes a numeric data-id and encrypts the actual source in
      // /stream/getSources. The canonical Zoko locator remains unchanged.
      if (host !== MEGAPLAY_HOST) continue;
      const fileId = html.match(/data-id\s*=\s*["']([^"']+)["']/i)?.[1];
      if (!fileId) continue;
      let sourceResponse: Response;
      try {
        sourceResponse = await fetchWithAttemptTimeout(fetchImpl, `${origin}stream/getSources?id=${encodeURIComponent(fileId)}`, {
          headers: {
            ...headers,
            Accept: "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            Referer: locator,
          },
        }, options);
      } catch {
        continue;
      }
      if (!sourceResponse.ok) continue;
      let sourcePayload: Record<string, unknown>;
      try {
        const parsed: unknown = await sourceResponse.json();
        sourcePayload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {};
      } catch {
        continue;
      }
      const decrypted = asString(sourcePayload.enc) ? decryptMegaPlayPayload(sourcePayload.enc as string) : null;
      const mediaUrl = addMegaPlayCdnToken(mediaUrlFromPayload(decrypted || sourcePayload) || "");
      if (!isPlayableMediaUrl(mediaUrl)) continue;
      return {
        url: mediaUrl,
        subtitles: [],
        subtitleMode: /\/sub(?:[/?]|$)/i.test(cleanUrl) ? "burned_in" : "unknown",
        title: html.match(/<title>\s*File\s+[^<]+/i)?.[0]?.replace(/<title>\s*/i, "").trim(),
        requiredHeaders: requiredHeadersFor(host),
      };
    }
    return fail();
  } catch {
    return fail();
  }
}
