import { randomUUID } from "node:crypto";

const API_BASE = "https://api.opensubtitles.com/api/v1";
const DEFAULT_USER_AGENT = "MeriStream/0.1 (subtitle integration)";
const REQUEST_TIMEOUT_MS = Math.max(1_000, Number(process.env.OPENSUBTITLES_TIMEOUT_MS || 5_000));

export interface OpenSubtitlesRequest {
  tmdbId: number;
  kind: "movie" | "series" | "anime";
  season?: number;
  episode?: number;
  languages?: string[];
}

export interface OpenSubtitlesTrack {
  id: string;
  label: string;
  language: string;
  url: string;
  is_default: boolean;
  provider: "opensubtitles";
}

export interface OpenSubtitlesResult {
  configured: boolean;
  tracks: OpenSubtitlesTrack[];
  reason?: "not_configured" | "search_failed" | "download_failed";
}

type SubtitleFile = { file_id?: number | string; file_name?: string };
type SubtitleEntry = {
  id?: string | number;
  attributes?: {
    language?: string;
    feature_details?: { year?: number; imdb_id?: number; tmdb_id?: number };
    files?: SubtitleFile[];
  };
};

function configuredKey(): string {
  return String(process.env.OPENSUBTITLES_API_KEY || "").trim();
}

function userAgent(): string {
  return String(process.env.OPENSUBTITLES_USER_AGENT || DEFAULT_USER_AGENT).trim();
}

function headers(includeJson = false): Record<string, string> {
  const result: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": userAgent(),
    "Api-Key": configuredKey(),
  };
  const token = String(process.env.OPENSUBTITLES_TOKEN || "").trim();
  if (token) result.Authorization = `Bearer ${token}`;
  if (includeJson) result["Content-Type"] = "application/json";
  return result;
}

async function requestJson(url: string, init: RequestInit): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function labelFor(language: string, fileName: string, index: number): string {
  const normalized = language || "und";
  const languageLabel = normalized === "es" || normalized.startsWith("es-")
    ? "Español"
    : normalized === "en" || normalized.startsWith("en-")
      ? "English"
      : normalized.toUpperCase();
  return fileName ? `${languageLabel} · ${fileName}` : `${languageLabel} · OpenSubtitles ${index + 1}`;
}

/**
 * Busca y descarga pistas solo cuando el operador configuró la API pública de
 * OpenSubtitles. Nunca se intenta un endpoint de descarga sin Api-Key/token.
 * Las URLs devueltas por OpenSubtitles son recursos de subtítulos, no embeds de
 * vídeo, y el player las consume mediante el elemento <track> nativo.
 */
export async function searchOpenSubtitles(input: OpenSubtitlesRequest): Promise<OpenSubtitlesResult> {
  const apiKey = configuredKey();
  if (!apiKey) return { configured: false, tracks: [], reason: "not_configured" };
  if (!Number.isInteger(input.tmdbId) || input.tmdbId <= 0) {
    return { configured: true, tracks: [], reason: "search_failed" };
  }

  const params = new URLSearchParams({
    tmdb_id: String(input.tmdbId),
    languages: (input.languages || ["es", "en"]).join(","),
    order_by: "download_count",
    order_direction: "desc",
  });
  if (input.kind !== "movie") {
    params.set("season_number", String(Math.max(1, input.season || 1)));
    params.set("episode_number", String(Math.max(1, input.episode || 1)));
  }

  const body = await requestJson(`${API_BASE}/subtitles?${params.toString()}`, {
    method: "GET",
    headers: headers(),
  });
  if (!body || !Array.isArray(body.data)) {
    return { configured: true, tracks: [], reason: "search_failed" };
  }

  const tracks: OpenSubtitlesTrack[] = [];
  const seenFiles = new Set<string>();
  for (const [index, entry] of (body.data as SubtitleEntry[]).entries()) {
    const attrs = entry?.attributes;
    const language = String(attrs?.language || "und").toLowerCase();
    const file = Array.isArray(attrs?.files) ? attrs.files.find((candidate) => candidate?.file_id != null) : null;
    if (!file?.file_id) continue;
    const fileId = String(file.file_id);
    if (seenFiles.has(fileId)) continue;
    seenFiles.add(fileId);

    // The download endpoint requires the configured API credentials. Without
    // a user token OpenSubtitles may reject the request; in that case we omit
    // the track instead of leaking a non-playable web page to the player.
    const download = await requestJson(`${API_BASE}/download`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ file_id: Number(file.file_id), sub_format: "vtt" }),
    });
    const url = typeof download?.link === "string"
      ? download.link
      : typeof download?.data?.link === "string"
        ? download.data.link
        : "";
    if (!/^https?:\/\//i.test(url)) continue;
    tracks.push({
      id: `opensubtitles-${fileId}-${randomUUID().slice(0, 8)}`,
      label: labelFor(language, String(file.file_name || ""), index),
      language,
      url,
      is_default: tracks.length === 0 && language.startsWith("es"),
      provider: "opensubtitles",
    });
    if (tracks.length >= 5) break;
  }

  return {
    configured: true,
    tracks,
    ...(tracks.length === 0 ? { reason: "download_failed" as const } : {}),
  };
}

export function openSubtitlesConfig(): { configured: boolean; tokenConfigured: boolean } {
  return {
    configured: Boolean(configuredKey()),
    tokenConfigured: Boolean(String(process.env.OPENSUBTITLES_TOKEN || "").trim()),
  };
}
