import { normalizeLanguageTag } from "../providers/providerPolicy";
import type { SubtitleSearchRequest } from "./types";

type CacheEntry = { value: string | null; expiresAt: number };

export class ExternalIdResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly timeoutMs = Math.max(1_000, Number(process.env.TMDB_EXTERNAL_ID_TIMEOUT_MS || 5_000)),
    private readonly ttlMs = 24 * 60 * 60_000,
  ) {}

  async resolve(request: SubtitleSearchRequest): Promise<string | null> {
    if (request.imdbId && /^tt\d+$/i.test(request.imdbId)) return request.imdbId.toLowerCase();
    if (!Number.isInteger(request.tmdbId) || request.tmdbId <= 0) return null;
    const key = `${request.kind}:${request.tmdbId}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const apiKey = String(process.env.TMDB_API_KEY || "").trim();
    if (!apiKey) {
      this.cache.set(key, { value: null, expiresAt: Date.now() + Math.min(this.ttlMs, 15 * 60_000) });
      return null;
    }

    const mediaType = request.kind === "movie" ? "movie" : "tv";
    const url = `https://api.themoviedb.org/3/${mediaType}/${request.tmdbId}/external_ids?api_key=${encodeURIComponent(apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let value: string | null = null;
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
      if (response.ok) {
        const body = await response.json().catch(() => null) as { imdb_id?: unknown } | null;
        const id = String(body?.imdb_id || "").trim().toLowerCase();
        value = /^tt\d+$/.test(id) ? id : null;
      }
    } catch {
      value = null;
    } finally {
      clearTimeout(timer);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
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
