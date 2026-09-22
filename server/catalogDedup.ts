import { normalizeTitleKey } from "./utils/titleNormalizer";

export interface CatalogIdentityShow {
  id?: string | null;
  title?: string | null;
  normalized_title?: string | null;
  base_normalized_title?: string | null;
  tmdb_id?: number | null;
  category?: string | null;
  year?: number | null;
  description?: string | null;
  poster_url?: string | null;
  banner_url?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genres?: string | null;
  original_title?: string | null;
  english_title?: string | null;
  japanese_title?: string | null;
  _count?: { episodes?: number | null } | null;
}

function strictKind(category: unknown): string {
  const value = String(category || "").trim().toLowerCase();
  if (/anime/.test(value)) return "anime";
  if (/(movie|pel[ií]cula|film)/.test(value)) return "movie";
  if (/(series|serie|tv|show)/.test(value)) return "series";
  return value || "unknown";
}

function tmdbFamily(category: unknown): string {
  const kind = strictKind(category);
  // TMDB movie IDs and TV IDs live in separate namespaces. Anime is TV.
  if (kind === "movie") return "movie";
  if (kind === "series" || kind === "anime") return "tv";
  return kind;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function identityTitle(show: CatalogIdentityShow): string {
  const persisted = String(show.normalized_title || "").trim().toLowerCase();
  if (persisted) return persisted;
  const base = String(show.base_normalized_title || "").trim().toLowerCase();
  if (base) return base;
  return normalizeTitleKey(String(show.title || ""));
}

/**
 * Stable public-catalog identity. Strong identity always wins; the title/year
 * fallback is deliberately conservative so remakes and cross-kind homonyms do
 * not collapse into one card.
 */
export function catalogIdentityKey(show: CatalogIdentityShow): string | null {
  const tmdbId = positiveInteger(show.tmdb_id);
  if (tmdbId) return `tmdb:${tmdbFamily(show.category)}:${tmdbId}`;

  const title = identityTitle(show);
  const year = positiveInteger(show.year);
  if (!title || !year) return null;
  return `title:${strictKind(show.category)}:${title}:${year}`;
}

function metadataScore(show: CatalogIdentityShow): number {
  const episodeCount = Math.max(0, Number(show._count?.episodes || 0));
  const description = String(show.description || "").trim();
  const genres = String(show.genres || "").trim();

  return (
    Math.min(episodeCount, 250) * 3 +
    (positiveInteger(show.tmdb_id) ? 40 : 0) +
    (show.poster_url || show.poster_path ? 12 : 0) +
    (show.banner_url || show.backdrop_path ? 8 : 0) +
    (description.length >= 40 ? 8 : description.length > 0 ? 3 : 0) +
    (genres && genres.toLowerCase() !== "multimedia" ? 4 : 0) +
    (show.original_title ? 2 : 0) +
    (show.english_title ? 1 : 0) +
    (show.japanese_title ? 1 : 0)
  );
}

/**
 * Removes duplicate public cards while preserving the original ordering. If
 * duplicate legacy rows exist, the richer row replaces the first slot rather
 * than moving the work elsewhere in the catalog.
 */
export function dedupeCatalogShows<T extends CatalogIdentityShow>(shows: readonly T[]): T[] {
  const output: T[] = [];
  const byIdentity = new Map<string, { index: number; score: number }>();

  for (const show of shows) {
    const key = catalogIdentityKey(show);
    if (!key) {
      output.push(show);
      continue;
    }

    const score = metadataScore(show);
    const existing = byIdentity.get(key);
    if (!existing) {
      byIdentity.set(key, { index: output.length, score });
      output.push(show);
      continue;
    }

    if (score > existing.score) {
      output[existing.index] = show;
      existing.score = score;
    }
  }

  return output;
}
