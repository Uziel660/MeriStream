import { lookupAnimeIdentityByTitle } from "../animeIdentity";
import { readExternalApiCache, writeExternalApiCache } from "../externalApiCache";
import { normalizeTitleKey } from "../utils/titleNormalizer";

export type IdentityKind = "movie" | "series" | "anime";
export type IdentityConfidence = "high" | "medium" | "low";
export type TmdbMediaType = "movie" | "tv";

export interface TmdbIdentityInput {
  title: string;
  aliases?: Array<string | null | undefined>;
  year?: number | null;
  kind: IdentityKind;
  imdbId?: string | null;
  originalLanguage?: string | null;
  originCountry?: string[];
}

export interface TmdbCandidateLike {
  id?: number;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  original_language?: string;
  origin_country?: string[];
  genre_ids?: number[];
  popularity?: number;
}

export interface TmdbIdentityResolution {
  tmdbId: number;
  mediaType: TmdbMediaType;
  title: string;
  originalTitle: string | null;
  year: number | null;
  score: number;
  confidence: IdentityConfidence;
  matchedAlias: string;
  reasons: string[];
  source: "imdb" | "tmdb-search" | "anime-alias";
}

type CacheEntry = { expiresAt: number; value: TmdbIdentityResolution | null };
const CACHE_TTL_MS = 30 * 60_000;
const cache = new Map<string, CacheEntry>();
const rawApiCache = new Map<string, { expiresAt: number; value: any }>();
const SEARCH_TIMEOUT_MS = 5_000;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueAliases(input: TmdbIdentityInput, extras: string[] = []): string[] {
  const seen = new Set<string>();
  return [input.title, ...(input.aliases || []), ...extras]
    .map((value) => text(value))
    .filter((value) => {
      const key = normalizeTitleKey(value);
      if (key.length < 2 || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function words(value: string): Set<string> {
  const normalized = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return new Set(normalized.split(/\s+/).filter((token) => token.length > 1));
}

function overlapRatio(a: string, b: string): number {
  const aWords = words(a);
  const bWords = words(b);
  if (aWords.size === 0 || bWords.size === 0) return 0;
  let intersection = 0;
  for (const token of aWords) if (bWords.has(token)) intersection++;
  return intersection / new Set([...aWords, ...bWords]).size;
}

function candidateNames(candidate: TmdbCandidateLike): string[] {
  const seen = new Set<string>();
  return [candidate.title, candidate.name, candidate.original_title, candidate.original_name]
    .map(text)
    .filter((value) => {
      const key = normalizeTitleKey(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function candidateYear(candidate: TmdbCandidateLike): number | null {
  const raw = text(candidate.release_date || candidate.first_air_date).slice(0, 4);
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1900 && parsed <= 2100 ? parsed : null;
}

function expectedMediaTypes(kind: IdentityKind): TmdbMediaType[] {
  return kind === "movie" ? ["movie"] : kind === "series" ? ["tv"] : ["tv", "movie"];
}

function asMediaType(value: unknown): TmdbMediaType | null {
  return value === "movie" || value === "tv" ? value : null;
}

export function scoreTmdbIdentityCandidate(
  input: TmdbIdentityInput,
  alias: string,
  candidate: TmdbCandidateLike,
): { score: number; confidence: IdentityConfidence; reasons: string[] } {
  const mediaType = asMediaType(candidate.media_type);
  if (!mediaType || !expectedMediaTypes(input.kind).includes(mediaType)) {
    return { score: 0, confidence: "low", reasons: ["wrong_media_type"] };
  }

  const aliasKey = normalizeTitleKey(alias);
  const names = candidateNames(candidate);
  let titleScore = 0;
  let exact = false;
  let contained = false;
  let bestOverlap = 0;
  for (const name of names) {
    const nameKey = normalizeTitleKey(name);
    if (!nameKey || !aliasKey) continue;
    if (nameKey === aliasKey) {
      exact = true;
      titleScore = Math.max(titleScore, 0.72);
      continue;
    }
    if (nameKey.includes(aliasKey) || aliasKey.includes(nameKey)) {
      contained = true;
      titleScore = Math.max(titleScore, 0.56);
    }
    bestOverlap = Math.max(bestOverlap, overlapRatio(alias, name));
  }
  if (!exact && !contained) titleScore = Math.max(titleScore, bestOverlap * 0.62);

  const reasons: string[] = [];
  if (exact) reasons.push("exact_title");
  else if (contained) reasons.push("contained_title");
  else if (bestOverlap >= 0.5) reasons.push("strong_token_overlap");
  else if (bestOverlap > 0) reasons.push("partial_token_overlap");

  // Sin una señal textual real el año/idioma jamás puede fabricar una identidad.
  if (titleScore < 0.2) return { score: titleScore, confidence: "low", reasons: [...reasons, "weak_title"] };

  let score = titleScore;
  const resultYear = candidateYear(candidate);
  const expectedYear = input.year && input.year > 1900 ? input.year : null;
  if (expectedYear && resultYear) {
    const distance = Math.abs(expectedYear - resultYear);
    if (distance === 0) {
      score += 0.2;
      reasons.push("exact_year");
    } else if (distance === 1) {
      score += 0.08;
      reasons.push("near_year");
    } else if (distance >= 3) {
      score -= Math.min(0.25, 0.1 + (distance - 2) * 0.025);
      reasons.push("year_mismatch");
    }
  }

  const expectedLanguage = text(input.originalLanguage).toLowerCase();
  if (expectedLanguage && text(candidate.original_language).toLowerCase() === expectedLanguage) {
    score += 0.06;
    reasons.push("original_language");
  }
  if (input.originCountry?.length && Array.isArray(candidate.origin_country)) {
    const expected = new Set(input.originCountry.map((country) => country.toUpperCase()));
    if (candidate.origin_country.some((country) => expected.has(String(country).toUpperCase()))) {
      score += 0.05;
      reasons.push("origin_country");
    }
  }

  if (input.kind === "anime") {
    const animation = Array.isArray(candidate.genre_ids) && candidate.genre_ids.includes(16);
    const japanese = text(candidate.original_language).toLowerCase() === "ja"
      || (Array.isArray(candidate.origin_country) && candidate.origin_country.includes("JP"));
    if (animation) {
      score += 0.05;
      reasons.push("animation_genre");
    }
    if (japanese) {
      score += 0.05;
      reasons.push("anime_origin");
    }
    // Anime con título parecido pero sin ninguna pista estructural sigue siendo
    // candidato revisable, no una identidad que el reparador deba escribir.
    if (!animation && !japanese) {
      score -= 0.12;
      reasons.push("weak_anime_structure");
    }
  }

  score = Math.max(0, Math.min(1, score));
  // Un título exacto es fuerte, pero si existe un año y contradice claramente
  // al candidato se fuerza revisión manual. Nombres reutilizados son comunes.
  const hasYearConflict = reasons.includes("year_mismatch");
  const high = score >= 0.84 && !hasYearConflict;
  const medium = score >= 0.58;
  return { score, confidence: high ? "high" : medium ? "medium" : "low", reasons };
}

async function fetchJson(url: string): Promise<any | null> {
  const cacheKey = url.replace(/([?&])api_key=[^&]+/i, "$1api_key=redacted");
  const memoryHit = rawApiCache.get(cacheKey);
  if (memoryHit && memoryHit.expiresAt > Date.now()) return memoryHit.value;

  const persistent = await readExternalApiCache<any>("tmdb", cacheKey);
  if (persistent !== null) {
    rawApiCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value: persistent });
    return persistent;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const value = await response.json();
    rawApiCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    await writeExternalApiCache("tmdb", cacheKey, value, CACHE_TTL_MS);
    return value;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function resolutionFromCandidate(
  input: TmdbIdentityInput,
  alias: string,
  candidate: TmdbCandidateLike,
  source: TmdbIdentityResolution["source"],
): TmdbIdentityResolution | null {
  const tmdbId = Number(candidate.id);
  const mediaType = asMediaType(candidate.media_type);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !mediaType) return null;
  const scored = scoreTmdbIdentityCandidate(input, alias, candidate);
  return {
    tmdbId,
    mediaType,
    title: text(candidate.title || candidate.name) || alias,
    originalTitle: text(candidate.original_title || candidate.original_name) || null,
    year: candidateYear(candidate),
    score: scored.score,
    confidence: scored.confidence,
    matchedAlias: alias,
    reasons: scored.reasons,
    source,
  };
}

async function findByImdb(input: TmdbIdentityInput, apiKey: string): Promise<TmdbIdentityResolution | null> {
  const imdbId = text(input.imdbId);
  if (!/^tt\d{5,12}$/i.test(imdbId)) return null;
  const payload = await fetchJson(`https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?external_source=imdb_id&api_key=${encodeURIComponent(apiKey)}`);
  const candidates = [
    ...(Array.isArray(payload?.movie_results) ? payload.movie_results.map((item: any) => ({ ...item, media_type: "movie" })) : []),
    ...(Array.isArray(payload?.tv_results) ? payload.tv_results.map((item: any) => ({ ...item, media_type: "tv" })) : []),
  ].filter((item) => expectedMediaTypes(input.kind).includes(item.media_type));
  const candidate = candidates[0];
  if (!candidate) return null;
  const resolved = resolutionFromCandidate(input, input.title, candidate, "imdb");
  return resolved ? { ...resolved, score: 1, confidence: "high", reasons: ["imdb_exact"] } : null;
}

async function searchAlias(input: TmdbIdentityInput, alias: string, apiKey: string, source: "tmdb-search" | "anime-alias"): Promise<TmdbIdentityResolution[]> {
  const results: TmdbIdentityResolution[] = [];
  for (const language of ["es-MX", "en-US"]) {
    const url = new URL("https://api.themoviedb.org/3/search/multi");
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("language", language);
    url.searchParams.set("query", alias);
    url.searchParams.set("include_adult", "false");
    const payload = await fetchJson(url.toString());
    for (const candidate of Array.isArray(payload?.results) ? payload.results.slice(0, 12) : []) {
      const resolution = resolutionFromCandidate(input, alias, candidate, source);
      if (resolution) results.push(resolution);
    }
    if (results.some((item) => item.confidence === "high")) break;
  }
  return results;
}

function better(a: TmdbIdentityResolution | null, b: TmdbIdentityResolution): TmdbIdentityResolution {
  if (!a) return b;
  const confidenceWeight = { low: 0, medium: 1, high: 2 } as const;
  const aWeight = confidenceWeight[a.confidence];
  const bWeight = confidenceWeight[b.confidence];
  if (bWeight !== aWeight) return bWeight > aWeight ? b : a;
  return b.score > a.score ? b : a;
}

/**
 * Shared confidence-aware TMDB identity resolver. It never writes to the DB.
 * Callers decide whether a confidence level is safe enough to persist.
 */
export async function resolveTmdbIdentityCandidate(input: TmdbIdentityInput): Promise<TmdbIdentityResolution | null> {
  const title = text(input.title);
  const apiKey = text(process.env.TMDB_API_KEY);
  if (!title || !apiKey) return null;
  const cacheKey = JSON.stringify({ ...input, aliases: uniqueAliases(input) });
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const imdb = await findByImdb(input, apiKey);
  if (imdb) {
    cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value: imdb });
    return imdb;
  }

  let best: TmdbIdentityResolution | null = null;
  const aliases = uniqueAliases(input);
  for (const alias of aliases) {
    const results = await searchAlias(input, alias, apiKey, "tmdb-search");
    for (const candidate of results) best = better(best, candidate);
    if (best?.confidence === "high" && best.score >= 0.92) break;
  }

  // Anime suele llegar con títulos romaji/traducidos que TMDB no indexa igual.
  // Reutilizamos el bridge Kitsu existente para conseguir aliases oficiales;
  // no usamos MAL/AniList como conjetura de TMDB.
  if (input.kind === "anime" && best?.confidence !== "high") {
    const animeIdentity = await lookupAnimeIdentityByTitle(title);
    const enrichedAliases = uniqueAliases(input, animeIdentity?.aliases || []).filter((alias) => !aliases.includes(alias));
    for (const alias of enrichedAliases) {
      const results = await searchAlias(input, alias, apiKey, "anime-alias");
      for (const candidate of results) best = better(best, candidate);
      if (best?.confidence === "high" && best.score >= 0.92) break;
    }
  }

  cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value: best });
  return best;
}

export function clearTmdbIdentityResolverCache(): void {
  cache.clear();
  rawApiCache.clear();
}
