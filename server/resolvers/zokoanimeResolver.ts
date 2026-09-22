const ZOKO_HOST = "zokoanime.video";
const ZOKO_KEY = "otaku-embed-v1";
const DEFAULT_TIMEOUT_MS = 8_000;
const ZOKO_REFERER = "https://zokoanime.video/";
const ZOKO_FETCH_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.8",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
} as const;

export const ZOKO_REQUIRED_HEADERS = {
  Referer: ZOKO_REFERER,
} as const;

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
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ZokoResolution> {
  const fail = (): ZokoResolution => ({
    url: "",
    subtitles: [],
    subtitleMode: "unknown",
    requiredHeaders: { ...ZOKO_REQUIRED_HEADERS },
  });
  const cleanUrl = typeof embedUrl === "string" ? embedUrl.trim() : "";
  if (!cleanUrl || !isZokoAnimeUrl(cleanUrl)) return fail();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(cleanUrl, {
      signal: controller.signal,
      headers: {
        ...ZOKO_FETCH_HEADERS,
        Referer: ZOKO_REFERER,
      },
    });
    if (!response.ok) return fail();
    const html = await response.text();
    const token = html.match(/window\.__P\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!token) return fail();
    const payload = decodePayload(token);
    const mediaUrl = asString(payload?.src);
    if (!mediaUrl || !/^https:\/\//i.test(mediaUrl) || !/\.(?:m3u8|mpd|mp4)(?:[?#]|$)/i.test(mediaUrl)) {
      return fail();
    }
    const subtitles = asSubtitles(payload?.subtitles);
    return {
      url: mediaUrl,
      subtitles,
      subtitleMode: subtitles.length > 0
        ? "external"
        : /\/sub(?:[/?]|$)/i.test(cleanUrl) ? "burned_in" : "unknown",
      title: asString(payload?.title),
      requiredHeaders: { ...ZOKO_REQUIRED_HEADERS },
    };
  } catch {
    return fail();
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
