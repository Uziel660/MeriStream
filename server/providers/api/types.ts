export type DirectMediaKind = "movie" | "series" | "anime";
export type StreamType = "hls" | "dash" | "mp4";
export type ProviderGroup = "api" | "spanish-local" | "database";

export interface SubtitleTrack {
  language?: string | null;
  label?: string | null;
  url: string;
}

export interface ProviderRequest {
  tmdbId: number;
  kind: DirectMediaKind;
  season?: number;
  episode?: number;
  title?: string | null;
  year?: number | null;
  anilistId?: string | null;
  malId?: number | null;
  preferredAudio?: string[];
  preferredSubtitles?: string[];
}

export interface PlayableSource {
  provider: string;
  providerGroup: ProviderGroup;
  url: string;
  streamType: StreamType;
  audioLanguage?: string | null;
  subtitleLanguage?: string | null;
  subtitles: SubtitleTrack[];
  quality?: string | null;
  requiredHeaders?: Record<string, string>;
  score?: number;
  sourceStatus?: string | null;
  canonicalLocator?: string | null;
  expiresAt?: string | null;
}

export interface DirectStreamProvider {
  id: string;
  kinds: readonly DirectMediaKind[];
  resolve(req: ProviderRequest): Promise<PlayableSource[]>;
}

export function inferStreamType(url: string, declared?: string | null): StreamType | null {
  const value = String(declared || "").toLowerCase();
  if (value.includes("dash") || value.includes("mpd")) return "dash";
  if (value.includes("hls") || value.includes("m3u8")) return "hls";
  if (value === "mp4" || value.includes("video/mp4")) return "mp4";

  const normalized = String(url || "").toLowerCase();
  if (/\.mpd(?:[?#]|$)/.test(normalized)) return "dash";
  if (/\.m3u8(?:[?#]|$)/.test(normalized) || normalized.includes("/m3u8/") || normalized.includes("hls-vod")) return "hls";
  if (/\.mp4(?:[?#]|$)/.test(normalized)) return "mp4";
  return null;
}

/**
 * Primary API providers are intentionally strict: embeds/pages never cross this
 * boundary. The frontend must only receive media our own player can consume.
 */
export function playableUrl(url: unknown, declared?: string | null): { url: string; streamType: StreamType } | null {
  const value = String(url || "").trim();
  if (!/^https?:\/\//i.test(value)) return null;
  const streamType = inferStreamType(value, declared);
  if (!streamType) return null;
  return { url: value, streamType };
}
