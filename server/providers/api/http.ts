import type { PlayableSource, SubtitleTrack } from "./types";
import { playableUrl } from "./types";

const DEFAULT_TIMEOUT_MS = Math.max(1_000, Number(process.env.PROVIDER_GATEWAY_TIMEOUT_MS || 4_500));

export async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(init.headers || {}),
      },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeSubtitles(raw: any): SubtitleTrack[] {
  const values = Array.isArray(raw) ? raw : [];
  return values.map((item: any) => ({
    language: item?.language || item?.lang || item?.srclang || null,
    label: item?.label || item?.name || item?.title || null,
    url: String(item?.url || item?.src || item?.file || ""),
  })).filter((item: SubtitleTrack) => /^https?:\/\//i.test(item.url));
}

export function directFromUnknown(
  raw: any,
  provider: string,
  extra: Partial<PlayableSource> = {},
): PlayableSource | null {
  const candidate = playableUrl(
    raw?.url || raw?.stream_url || raw?.streamUrl || raw?.file || raw?.src,
    raw?.type || raw?.streamType || raw?.mimeType,
  );
  if (!candidate) return null;

  const subtitles = normalizeSubtitles(raw?.subtitles || raw?.tracks || extra.subtitles);
  return {
    provider,
    providerGroup: "api",
    url: candidate.url,
    streamType: candidate.streamType,
    audioLanguage: raw?.audio_language || raw?.audioLanguage || raw?.language || extra.audioLanguage || null,
    subtitleLanguage: raw?.subtitle_language || raw?.subtitleLanguage || extra.subtitleLanguage || null,
    subtitles,
    quality: raw?.quality || raw?.resolution || extra.quality || null,
    requiredHeaders: raw?.headers || raw?.requiredHeaders || raw?.behaviorHints?.proxyHeaders?.request || extra.requiredHeaders,
    canonicalLocator: raw?.canonical_locator || raw?.canonicalLocator || extra.canonicalLocator || null,
    expiresAt: raw?.expiresAt || raw?.expires_at || extra.expiresAt || null,
    sourceStatus: "discovered",
    ...extra,
    url: candidate.url,
    streamType: candidate.streamType,
    subtitles,
  };
}
