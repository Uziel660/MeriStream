import { normalizeLanguageTag } from "../providers/providerPolicy";
import type { SubtitleSearchRequest } from "./types";

type CacheEntry = { value: string | null; expiresAt: number };
type TmdbExternalDetail = {
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  external_ids?: { imdb_id?: unknown };
};

function normalizedTitle(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function detailYear(detail: TmdbExternalDetail): number | null {
  const raw = String(detail.release_date || detail.first_air_date || "").slice(0, 4);
  const year = Number.parseInt(raw, 10);
  return Number.isInteger(year) && year > 1900 ? year : null;
}

function animeDetailScore(request: SubtitleSearchRequest, detail: TmdbExternalDetail): number {
  const aliases = [request.title, ...(request.titleAliases || [])]
    .map(normalizedTitle)
    .filter(Boolean);
  const names = [detail.title, detail.name, detail.original_title, detail.original_name]
    .map(normalizedTitle)
    .filter(Boolean);

  // Si el caller no conoce ningún título, conservar el comportamiento legacy
  // y dejar que TV sea el fallback. Con títulos disponibles sí exigimos una
  // señal textual para no confundir namespaces con el mismo ID numérico.
  if (aliases.length === 0) return 1;
  let score = 0;
  for (const alias of aliases) {
    for (const name of names) {
      if (alias === name) score = Math.max(score, 100);
      else if (alias.length >= 4 && (alias.includes(name) || name.includes(alias))) score = Math.max(score, 72);
    }
  }
  if (score === 0) return 0;

  const expectedYear = Number(request.year || 0);
  const year = detailYear(detail);
  if (expectedYear > 1900 && year) {
    const distance = Math.abs(expectedYear - year);
    if (distance === 0) score += 20;
    else if (distance === 1) score += 6;
    else if (distance >= 3) score -= 35;
  }
  return score;
}

export class ExternalIdResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly timeoutMs = Math.max(1_000, Number(process.env.TMDB_EXTERNAL_ID_TIMEOUT_MS || 5_000)),
    private readonly ttlMs = 24 * 60 * 60_000,
  ) {}

  async resolve(request: SubtitleSearchRequest): Promise<string | null> {
    if (request.imdbId && /^tt\d+$/i.test(request.imdbId)) return request.imdbId.toLowerCase();
    if (!Number.isInteger(request.tmdbId) || request.tmdbId <= 0) return null;
    const identityHint = request.kind === "anime"
      ? `${normalizedTitle(request.title)}:${Number(request.year || 0)}`
      : "";
    const key = `${request.kind}:${request.tmdbId}:${identityHint}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const apiKey = String(process.env.TMDB_API_KEY || "").trim();
    if (!apiKey) {
      this.cache.set(key, { value: null, expiresAt: Date.now() + Math.min(this.ttlMs, 15 * 60_000) });
      return null;
    }

    const value = request.kind === "anime"
      ? await this.resolveAnime(request, apiKey)
      : await this.resolveSingle(request.kind === "movie" ? "movie" : "tv", request.tmdbId, apiKey);
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }

  private async resolveSingle(mediaType: "movie" | "tv", tmdbId: number, apiKey: string): Promise<string | null> {
    const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/external_ids?api_key=${encodeURIComponent(apiKey)}`;
    const body = await this.fetchJson(url) as { imdb_id?: unknown } | null;
    const id = String(body?.imdb_id || "").trim().toLowerCase();
    return /^tt\d+$/.test(id) ? id : null;
  }

  private async resolveAnime(request: SubtitleSearchRequest, apiKey: string): Promise<string | null> {
    const results = await Promise.all((["tv", "movie"] as const).map(async (mediaType) => {
      const url = `https://api.themoviedb.org/3/${mediaType}/${request.tmdbId}?append_to_response=external_ids&language=en-US&api_key=${encodeURIComponent(apiKey)}`;
      const detail = await this.fetchJson(url) as TmdbExternalDetail | null;
      if (!detail) return null;
      const imdbId = String(detail.external_ids?.imdb_id || "").trim().toLowerCase();
      if (!/^tt\d+$/.test(imdbId)) return null;
      return { mediaType, imdbId, score: animeDetailScore(request, detail) };
    }));

    const candidates = results
      .filter((value): value is { mediaType: "movie" | "tv"; imdbId: string; score: number } => Boolean(value))
      .sort((a, b) => b.score - a.score || (a.mediaType === "tv" ? -1 : 1));
    const best = candidates[0];
    if (!best) return null;

    // Con título/aliases disponibles exigimos exact/contained fuerte. Sin
    // título, score=1 conserva el fallback TV histórico para compatibilidad.
    const hasTitleHint = Boolean(normalizedTitle(request.title) || request.titleAliases?.some((alias) => normalizedTitle(alias)));
    if (hasTitleHint && best.score < 72) return null;
    return best.imdbId;
  }

  private async fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
      return response.ok ? response.json().catch(() => null) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

export function normalizePreferredLanguages(values?: string[]): string[] {
  return (values || ["es-419", "es", "en"])
    .map((value) => normalizeLanguageTag(value))
    .filter((value): value is string => Boolean(value));
}
