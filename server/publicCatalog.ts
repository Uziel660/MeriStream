/**
 * TMDB-backed public catalog.
 *
 * The catalog is intentionally independent from the imported provider tables:
 * a card is identified by its TMDB namespace and providers are resolved later
 * by the gateway. This keeps a stale or incomplete scraper import from hiding
 * a title that TMDB knows about.
 */

import { readExternalApiCache, writeExternalApiCache } from "./externalApiCache";

export type PublicCatalogKind = "movie" | "series" | "anime";

export type CatalogQueryType = "imdb" | "tmdb" | "tvdb" | "title";

export interface ParsedCatalogQuery {
  type: CatalogQueryType;
  raw: string;
  tmdbId?: number;
  imdbId?: string;
  tvdbId?: number;
  title?: string;
  year?: number | null;
}

export interface CatalogLookupCandidate {
  tmdb_id: number;
  imdb_id: string | null;
  title: string;
  original_title: string | null;
  media_type: "movie" | "tv";
  kind?: PublicCatalogKind;
  category?: PublicCatalogKind;
  year: number | null;
  poster_path: string | null;
  poster_url: string;
  backdrop_path: string | null;
  overview: string;
  vote_average: number;
  genres: string[];
  confidence: number;
  popularity?: number;
}

export interface CatalogLookupResult {
  ok: boolean;
  query: string;
  exact_match: boolean;
  candidates: CatalogLookupCandidate[];
  shows: PublicCatalogShow[];
}

export interface PublicCatalogShow {
  id: string;
  title: string;
  tmdb_id: number;
  imdb_id?: string | null;
  anilist_id?: string | null;
  mal_id?: number | null;
  kitsu_id?: string | null;
  title_aliases?: string[];
  kind: PublicCatalogKind;
  category: PublicCatalogKind;
  original_title?: string | null;
  original_language?: string | null;
  english_title?: string | null;
  japanese_title?: string | null;
  description: string;
  synopsis: string;
  poster_url: string;
  logo_url?: string | null;
  banner_url: string;
  backdrop_url: string;
  poster_path: string | null;
  backdrop_path: string | null;
  rating: number;
  popularity?: number;
  year: number | null;
  genres: string[];
  episode_count: number;
  is_trending?: boolean;
  status?: string | null;
  sources: {
    master_m3u8: string;
    fallback_mp4: string | null;
    qualities: any[];
    subtitles: any[];
  };
}

export interface PublicCatalogEpisode {
  id: string;
  show_id: string;
  title: string;
  episode_number: number;
  season_number: number;
  source_url: string;
}

export interface PublicCatalogDetail extends PublicCatalogShow {
  episodes: PublicCatalogEpisode[];
  external_ids: {
    imdb_id: string | null;
    tvdb_id: number | null;
    wikidata_id: string | null;
  };
}

export interface PublicCatalogResult {
  shows: PublicCatalogShow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** First TMDB page that has not been requested by this response. */
  nextPage: number;
  source: "tmdb";
}

type TmdbItem = {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  popularity?: number;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
  genres?: Array<{ id: number; name: string }>;
  original_language?: string;
  number_of_episodes?: number;
  status?: string;
  seasons?: Array<{ season_number: number; episode_count: number; air_date?: string | null }>;
};

type TmdbListResponse = {
  page?: number;
  total_results?: number;
  total_pages?: number;
  results?: TmdbItem[];
};

type TmdbFindResponse = {
  movie_results?: TmdbItem[];
  tv_results?: TmdbItem[];
};

type TmdbDetail = TmdbItem & {
  external_ids?: {
    imdb_id?: string | null;
    tvdb_id?: number | null;
    wikidata_id?: string | null;
  };
  translations?: {
    translations?: Array<{
      iso_639_1?: string;
      iso_3166_1?: string;
      data?: { title?: string; name?: string; overview?: string };
    }>;
  };
  images?: {
    logos?: Array<{
      file_path?: string | null;
      iso_639_1?: string | null;
      width?: number;
      height?: number;
    }>;
  };
};

type AnimeIdentity = {
  anilistId: string | null;
  malId: number | null;
  kitsuId: string | null;
  aliases: string[];
};

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p";
const CACHE_TTL_MS = Math.max(30_000, Number(process.env.TMDB_CATALOG_CACHE_MS || 300_000));
const CACHE_MAX_ENTRIES = 128;
const cache = new Map<string, { expires: number; value: unknown }>();

const GENRE_NAMES: Record<number, string> = {
  12: "Aventura", 14: "Fantasía", 16: "Animación", 18: "Drama", 27: "Terror",
  28: "Acción", 35: "Comedia", 36: "Historia", 37: "Western", 53: "Suspenso",
  80: "Crimen", 99: "Documental", 878: "Ciencia ficción", 9648: "Misterio",
  10402: "Música", 10749: "Romance", 10751: "Familia", 10752: "Bélica",
  10759: "Acción y aventura", 10762: "Infantil", 10763: "Noticias", 10764: "Reality",
  10765: "Ciencia ficción y fantasía", 10766: "Telenovela", 10767: "Talk",
  10768: "Guerra y política",
};

// TMDB does not use exactly the same genre dictionary for movies and TV.
// Keep the public filter's movie id as the canonical key, then translate it
// only for the /discover/tv request so a genre such as Terror still returns
// a useful series bucket instead of an empty response.
const TV_GENRE_IDS_BY_MOVIE_GENRE: Record<number, number> = {
  12: 10759,
  14: 10765,
  16: 16,
  18: 18,
  27: 9648,
  28: 10759,
  35: 35,
  36: 18,
  37: 37,
  53: 9648,
  80: 80,
  99: 99,
  878: 10765,
  9648: 9648,
  10402: 18,
  10749: 18,
  10751: 10751,
  10752: 10768,
  10759: 10759,
  10762: 10762,
  10765: 10765,
  10768: 10768,
};

function imageUrl(
  path: string | null | undefined,
  size: "w342" | "w500" | "w780" | "w1280" | "original" = "w500",
): string {
  return path ? `${IMAGE_BASE}/${size}${path}` : "";
}

function publicTitleKey(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function publicMetadataScore(show: PublicCatalogShow): number {
  const description = String(show.description || "").trim();
  return (
    (description.length >= 40 ? 4 : description.length > 0 ? 1 : 0) +
    (show.poster_url ? 2 : 0) +
    (show.backdrop_url ? 1 : 0) +
    (show.rating > 0 ? 1 : 0) +
    (show.episode_count > 0 ? 1 : 0)
  );
}

function isPublicMetadataStub(show: PublicCatalogShow): boolean {
  return !String(show.description || "").trim() && show.rating <= 0 && show.episode_count <= 0;
}

/**
 * TMDB can contain duplicate entries for the same title/year. This is most
 * visible when one record is a complete work and another is an empty stub
 * with a different numeric id. Keep both when both have meaningful metadata,
 * but remove the clearly empty stub so selecting a search result cannot route
 * playback to a metadata-less duplicate.
 */
export function dedupePoorPublicDuplicates(shows: readonly PublicCatalogShow[]): PublicCatalogShow[] {
  const output: PublicCatalogShow[] = [];
  const byKey = new Map<string, { index: number; score: number }>();
  for (const show of shows) {
    const year = Number(show.year || 0);
    const title = publicTitleKey(show.title || show.original_title);
    const kind = show.kind === "movie" ? "movie" : "tv";
    const key = title && year > 0 ? `${kind}:${title}:${year}` : "";
    if (!key) {
      output.push(show);
      continue;
    }
    const score = publicMetadataScore(show);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, { index: output.length, score });
      output.push(show);
      continue;
    }
    const previousIsStub = isPublicMetadataStub(output[previous.index]);
    const currentIsStub = isPublicMetadataStub(show);
    if (previousIsStub && !currentIsStub) {
      output[previous.index] = show;
      previous.score = score;
    } else if (!previousIsStub && currentIsStub) {
      continue;
    } else {
      output.push(show);
    }
  }
  return output;
}

function isSuspiciousPosterUrl(url: unknown): boolean {
  // TMDB occasionally returns a tiny transparent/logo PNG in poster_path
  // (for example, a 177x21 title wordmark). It is a valid CDN URL but it is
  // not a usable vertical poster for a card.
  return /\.(?:png|svg)(?:[?#]|$)/i.test(String(url || ""));
}

function yearFrom(item: TmdbItem): number | null {
  const value = item.release_date || item.first_air_date || "";
  const match = /^(\d{4})/.exec(value);
  return match ? Number(match[1]) : null;
}

function titleFrom(item: TmdbItem): string {
  return String(item.title || item.name || item.original_title || item.original_name || "Sin título").trim();
}

function genreNames(item: TmdbItem): string[] {
  const named = Array.isArray(item.genres) ? item.genres.map((genre) => genre.name).filter(Boolean) : [];
  if (named.length) return [...new Set(named)];
  return [...new Set((item.genre_ids || []).map((id) => GENRE_NAMES[id]).filter(Boolean))];
}

function isAnimeItem(item: TmdbItem): boolean {
  const isAnimated = Boolean(item.genre_ids?.includes(16) || item.genres?.some((genre) => genre.id === 16));
  // TMDB uses the animation genre for western cartoons as well. Keep the
  // public Anime rail limited to Japanese/Chinese/Korean-origin animation so
  // a title such as Rick and Morty is not duplicated as an anime card.
  return isAnimated && ["ja", "zh", "ko"].includes(String(item.original_language || "").toLowerCase());
}

function publicId(kind: PublicCatalogKind, tmdbId: number): string {
  return `tmdb-${kind}-${tmdbId}`;
}

export function parsePublicCatalogId(value: string): { kind: PublicCatalogKind; tmdbId: number } | null {
  const match = /^tmdb-(movie|series|anime)-(\d+)$/.exec(String(value || ""));
  if (!match) return null;
  const tmdbId = Number(match[2]);
  return Number.isInteger(tmdbId) && tmdbId > 0
    ? { kind: match[1] as PublicCatalogKind, tmdbId }
    : null;
}

export function mapTmdbItem(item: TmdbItem, kind: PublicCatalogKind, isTrending = false): PublicCatalogShow {
  const title = titleFrom(item);
  const poster = imageUrl(item.poster_path);
  const backdrop = imageUrl(item.backdrop_path, "w780") || poster;
  const originalTitle = item.original_title || item.original_name || null;
  return {
    id: publicId(kind, item.id),
    title,
    tmdb_id: item.id,
    imdb_id: null,
    anilist_id: null,
    mal_id: null,
    kitsu_id: null,
    title_aliases: [...new Set([title, originalTitle].filter((value): value is string => Boolean(value)))],
    kind,
    category: kind,
    original_title: originalTitle,
    original_language: item.original_language || null,
    english_title: item.original_language === "en" ? originalTitle : null,
    japanese_title: item.original_language === "ja" ? originalTitle : null,
    description: String(item.overview || ""),
    synopsis: String(item.overview || ""),
    poster_url: poster,
    logo_url: null,
    banner_url: backdrop,
    backdrop_url: backdrop,
    poster_path: item.poster_path || null,
    backdrop_path: item.backdrop_path || null,
    rating: Number.isFinite(Number(item.vote_average)) ? Number(item.vote_average) : 0,
    popularity: Number.isFinite(Number(item.popularity)) ? Number(item.popularity) : 0,
    year: yearFrom(item),
    genres: genreNames(item),
    episode_count: Number(item.number_of_episodes || 0),
    is_trending: isTrending,
    status: item.status || null,
    sources: { master_m3u8: "", fallback_mp4: null, qualities: [], subtitles: [] },
  };
}

async function fetchWikidataIdentity(tmdbId: number): Promise<AnimeIdentity | null> {
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
  const cacheKey = `wikidata-tmdb:${tmdbId}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value as AnimeIdentity;
  try {
    const query = `SELECT ?mal ?anilist WHERE { ?item wdt:P4983 "${tmdbId}". OPTIONAL { ?item wdt:P4086 ?mal. } OPTIONAL { ?item wdt:P8729 ?anilist. } } LIMIT 1`;
    const url = new URL("https://query.wikidata.org/sparql");
    url.searchParams.set("format", "json");
    url.searchParams.set("query", query);
    const response = await fetch(url, {
      headers: { Accept: "application/sparql-results+json", "User-Agent": "MeriStream/1.0 (identity resolver)" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const payload = await response.json() as any;
    const binding = payload?.results?.bindings?.[0];
    if (!binding) return null;
    const mal = String(binding.mal?.value || "").trim();
    const anilist = String(binding.anilist?.value || "").trim();
    const value: AnimeIdentity = {
      malId: /^\d+$/.test(mal) ? Number(mal) : null,
      anilistId: /^\d+$/.test(anilist) ? anilist : null,
      kitsuId: null,
      aliases: [],
    };
    if (!value.malId && !value.anilistId) return null;
    cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, value });
    return value;
  } catch {
    return null;
  }
}

/**
 * Completes a partial Wikidata cross-reference through AniList. Wikidata may
 * contain only one of MAL/AniList; querying by the known numeric id lets
 * AniList return the paired id without guessing from a localized title.
 */
async function fetchAniListIdentityById(identity: Pick<AnimeIdentity, "anilistId" | "malId">): Promise<AnimeIdentity | null> {
  const anilistId = identity.anilistId && /^\d+$/.test(String(identity.anilistId))
    ? Number(identity.anilistId)
    : undefined;
  const malId = Number.isInteger(identity.malId) && Number(identity.malId) > 0
    ? Number(identity.malId)
    : undefined;
  if (anilistId === undefined && malId === undefined) return null;

  const cacheKey = `anilist-crosswalk:${anilistId ?? `mal-${malId}`}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value as AnimeIdentity;

  const variables: Record<string, number> = {};
  if (anilistId !== undefined) variables.id = anilistId;
  else if (malId !== undefined) variables.idMal = malId;
  try {
    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "MeriStream/1.0" },
      body: JSON.stringify({
        query: `query ($id: Int, $idMal: Int) { Media(id: $id, idMal: $idMal, type: ANIME) { id idMal title { romaji english native } synonyms } }`,
        variables,
      }),
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return null;
    const media = (await response.json() as any)?.data?.Media;
    if (!media) return null;
    const aliases = [media.title?.romaji, media.title?.english, media.title?.native, ...(Array.isArray(media.synonyms) ? media.synonyms : [])]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    const value: AnimeIdentity = {
      anilistId: media.id != null ? String(media.id) : null,
      malId: Number.isInteger(media.idMal) ? Number(media.idMal) : null,
      kitsuId: null,
      aliases: [...new Set(aliases)],
    };
    cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, value });
    return value;
  } catch {
    return null;
  }
}

function mergeAnimeIdentity(primary: AnimeIdentity, secondary: AnimeIdentity | null): AnimeIdentity {
  if (!secondary) return primary;
  return {
    anilistId: primary.anilistId || secondary.anilistId,
    malId: primary.malId || secondary.malId,
    kitsuId: primary.kitsuId || secondary.kitsuId,
    aliases: [...new Set([...(primary.aliases || []), ...(secondary.aliases || [])])],
  };
}

function applySpanishTranslation(detail: TmdbDetail): TmdbDetail {
  const translations = Array.isArray(detail.translations?.translations)
    ? detail.translations.translations
    : [];
  const spanish = translations
    .filter((entry) => entry.iso_639_1?.toLowerCase() === "es" && (entry.data?.title || entry.data?.name))
    .sort((a, b) => {
      const rank = (entry: typeof a): number => {
        const locale = String(entry.iso_3166_1 || "").toUpperCase();
        return locale === "MX" ? 0 : locale === "US" ? 1 : locale === "ES" ? 2 : 3;
      };
      return rank(a) - rank(b);
    })[0];
  if (!spanish?.data) return detail;
  const translatedTitle = String(spanish.data.title || spanish.data.name || "").trim();
  const translatedOverview = String(spanish.data.overview || "").trim();
  if (!translatedTitle && !translatedOverview) return detail;
  return {
    ...detail,
    ...(detail.title !== undefined ? { title: translatedTitle || detail.title } : {}),
    ...(detail.name !== undefined ? { name: translatedTitle || detail.name } : {}),
    ...(translatedOverview ? { overview: translatedOverview } : {}),
  };
}

function tmdbLogoUrl(detail: TmdbDetail): string | null {
  const logos = Array.isArray(detail.images?.logos) ? detail.images.logos : [];
  const valid = logos.filter((logo) => typeof logo.file_path === "string" && logo.file_path.startsWith("/"));
  if (valid.length === 0) return null;
  const languageRank = (logo: (typeof valid)[number]): number => {
    const language = String(logo.iso_639_1 || "").toLowerCase();
    return language === "es" ? 0 : language === "en" ? 1 : !language ? 2 : 3;
  };
  const selected = [...valid].sort((left, right) =>
    languageRank(left) - languageRank(right) || Number(right.width || 0) - Number(left.width || 0),
  )[0];
  return selected.file_path ? imageUrl(selected.file_path, "w780") : null;
}

type PosterRepairTarget = {
  tmdb_id?: number | null;
  kind?: PublicCatalogKind | string | null;
  category?: PublicCatalogKind | string | null;
  poster_url?: string | null;
  poster_path?: string | null;
  banner_url?: string | null;
  backdrop_url?: string | null;
};

/** Fetches only the canonical TMDB artwork for a title whose list result
 * contains a logo/wordmark instead of a poster. The API key stays server-side. */
export async function getPublicCatalogVisual(kindValue: unknown, tmdbIdValue: unknown): Promise<{
  poster_url: string;
  poster_path: string | null;
} | null> {
  const kind = parseKind(kindValue);
  const tmdbId = Number.parseInt(String(tmdbIdValue || ""), 10);
  if (kind === "all" || !Number.isInteger(tmdbId) || tmdbId <= 0) return null;

  const request = async (path: string) => tmdbFetch<TmdbDetail>(path, {
    language: "es-419",
  });
  let detail: TmdbDetail;
  try {
    detail = await request(kind === "movie" ? `/movie/${tmdbId}` : `/tv/${tmdbId}`);
  } catch {
    if (kind !== "anime") return null;
    try {
      detail = await request(`/movie/${tmdbId}`);
    } catch {
      return null;
    }
  }

  if (!detail.poster_path || isSuspiciousPosterUrl(detail.poster_path)) return null;
  return {
    poster_url: imageUrl(detail.poster_path),
    poster_path: detail.poster_path,
  };
}

/** Repairs suspicious TMDB artwork with bounded concurrency so a catalog
 * page never opens dozens of detail requests at once. */
export async function repairTmdbPosters<T extends PosterRepairTarget>(shows: T[]): Promise<T[]> {
  const candidates = shows.filter((show) =>
    Number.isInteger(Number(show.tmdb_id)) &&
    Number(show.tmdb_id) > 0 &&
    (isSuspiciousPosterUrl(show.poster_url) || !show.poster_url || !show.poster_path),
  ).slice(0, 20);
  if (candidates.length === 0) return shows;

  const repaired = new Map<number, { poster_url: string; poster_path: string | null }>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++];
      const visual = await getPublicCatalogVisual(candidate.kind || candidate.category, candidate.tmdb_id);
      if (visual) repaired.set(Number(candidate.tmdb_id), visual);
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, candidates.length) }, () => worker()));

  return shows.map((show) => {
    const visual = repaired.get(Number(show.tmdb_id));
    return visual ? { ...show, ...visual } : show;
  });
}

async function fetchAnimeIdentity(tmdbId: number, title: string, originalTitle?: string | null): Promise<AnimeIdentity> {
  const search = String(title || originalTitle || "").trim();
  const empty: AnimeIdentity = { anilistId: null, malId: null, kitsuId: null, aliases: [] };
  if (!search) return empty;
  // Prefer an exact TMDB cross-reference when available. This avoids fuzzy
  // title search attaching a franchise or a synopsis-only Kitsu result.
  const wikidata = await fetchWikidataIdentity(tmdbId);
  if (wikidata) {
    const complete = wikidata.malId && wikidata.anilistId
      ? wikidata
      : mergeAnimeIdentity(wikidata, await fetchAniListIdentityById(wikidata));
    if (complete.malId || complete.anilistId) return complete;
  }
  const cacheKey = `anilist:${search.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value as AnimeIdentity;
  try {
    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "MeriStream/1.0" },
      body: JSON.stringify({
        query: `query ($search: String) { Media(search: $search, type: ANIME) { id idMal title { romaji english native } synonyms } }`,
        variables: { search },
      }),
      signal: AbortSignal.timeout(6_000),
    });
    if (response.ok) {
      const payload = await response.json() as any;
      const media = payload?.data?.Media;
      if (media) {
        const aliases = [media.title?.romaji, media.title?.english, media.title?.native, ...(Array.isArray(media.synonyms) ? media.synonyms : [])]
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .map((value) => value.trim());
        const value: AnimeIdentity = {
          anilistId: media.id != null ? String(media.id) : null,
          malId: Number.isInteger(media.idMal) ? Number(media.idMal) : null,
          kitsuId: null,
          aliases: [...new Set(aliases)],
        };
        cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, value });
        return value;
      }
    }
  } catch {
    // AniList can be temporarily unavailable; Kitsu's public mapping endpoint
    // is a compatible no-key fallback for MAL/AniList identity discovery.
  }
  try {
    const searchUrl = new URL("https://kitsu.io/api/edge/anime");
    searchUrl.searchParams.set("filter[text]", search);
    // Kitsu's full-text search also matches synopsis text. Ask for several
    // candidates and select only a title-level match; taking the first row can
    // map an unrelated show (e.g. a Panty & Stocking synopsis mentioning
    // "overflow") to the requested TMDB anime.
    searchUrl.searchParams.set("page[limit]", "20");
    const response = await fetch(searchUrl, {
      headers: { Accept: "application/vnd.api+json", "User-Agent": "MeriStream/1.0" },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return empty;
    const payload = await response.json() as any;
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const normalizedSearch = search.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, " ").trim();
    const titleTokens = (value: string) => new Set(value.split(/\s+/).filter((token) => token.length > 1));
    const scoreRow = (row: any): number => {
      const attributes = row?.attributes || {};
      const values = [attributes.canonicalTitle, attributes.titles?.canonical, ...Object.values(attributes.titles || {}), attributes.slug]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => String(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, " ").trim());
      let best = 0;
      for (const value of values) {
        if (value === normalizedSearch) best = Math.max(best, 1);
        const left = titleTokens(normalizedSearch);
        const right = titleTokens(value);
        const common = [...left].filter((token) => right.has(token)).length;
        if (left.size && right.size) best = Math.max(best, common / Math.max(left.size, right.size));
      }
      return best;
    };
    const anime = rows
      .map((row: any) => ({ row, score: scoreRow(row) }))
      .sort((left: any, right: any) => right.score - left.score)[0];
    if (!anime || anime.score < 0.8) return empty;
    const animeRow = anime.row;
    const mappingsResponse = await fetch(`https://kitsu.io/api/edge/anime/${encodeURIComponent(String(animeRow.id))}/mappings`, {
      headers: { Accept: "application/vnd.api+json", "User-Agent": "MeriStream/1.0" },
      signal: AbortSignal.timeout(6_000),
    });
    const mappingsPayload = mappingsResponse.ok ? await mappingsResponse.json() as any : null;
    const mappings = Array.isArray(mappingsPayload?.data) ? mappingsPayload.data : [];
    const mal = mappings.find((entry: any) => entry?.attributes?.externalSite === "myanimelist/anime")?.attributes?.externalId;
    const anilist = mappings.find((entry: any) => entry?.attributes?.externalSite === "anilist/anime")?.attributes?.externalId;
    const attributes = animeRow.attributes || {};
    const aliases = [attributes.canonicalTitle, attributes.titles?.en, attributes.titles?.en_jp, attributes.titles?.ja_jp]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    const value: AnimeIdentity = {
      anilistId: anilist ? String(anilist) : null,
      malId: mal && /^\d+$/.test(String(mal)) ? Number(mal) : null,
      kitsuId: String(animeRow.id),
      aliases: [...new Set(aliases)],
    };
    cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, value });
    return value;
  } catch {
    return empty;
  }
}

function getApiKey(): string {
  return String(process.env.TMDB_API_KEY || "").trim();
}

async function tmdbFetch<T>(path: string, params: Record<string, string | number | undefined>, personalApiKey?: string): Promise<T> {
  const apiKey = String(personalApiKey || getApiKey()).trim().slice(0, 128);
  if (!apiKey) throw new Error("TMDB_API_KEY no configurada");
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const cacheKey = url.toString().replace(/([?&])api_key=[^&]+/, "$1api_key=redacted");
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value as T;
  const persistent = await readExternalApiCache<T>("tmdb", cacheKey);
  if (persistent) {
    cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, value: persistent });
    return persistent;
  }
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "MeriStream/1.0" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`TMDB HTTP ${response.status}`);
  const value = await response.json() as T;
  cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, value });
  await writeExternalApiCache("tmdb", cacheKey, value, CACHE_TTL_MS);
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return value;
}

function parseKind(value: unknown): PublicCatalogKind | "all" {
  const kind = String(value || "all").toLowerCase();
  if (kind === "movie" || kind === "series" || kind === "anime") return kind;
  return "all";
}

/**
 * The unified public rail must expose every media family. TMDB returns each
 * family in its own ranked list; concatenating those lists and slicing would
 * fill the requested limit with movies before a series or anime can appear.
 * Interleave the ranked buckets so the first viewport always has all three
 * kinds while preserving each bucket's internal TMDB order.
 */
function interleaveCatalogShows(shows: PublicCatalogShow[]): PublicCatalogShow[] {
  const buckets: Record<PublicCatalogKind, PublicCatalogShow[]> = {
    movie: [],
    series: [],
    anime: [],
  };
  for (const show of shows) buckets[show.kind].push(show);
  const ordered: PublicCatalogShow[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const kind of ["movie", "series", "anime"] as const) {
      const next = buckets[kind].shift();
      if (!next) continue;
      ordered.push(next);
      added = true;
    }
  }
  return ordered;
}

function searchTitleScore(show: PublicCatalogShow, query: string): number {
  const needle = publicTitleKey(query);
  if (!needle) return 0;
  const fields = [
    { value: show.title, weight: 1_000 },
    ...(show.title_aliases || []).map((value) => ({ value, weight: 900 })),
    { value: show.english_title, weight: 880 },
    { value: show.original_title, weight: 820 },
    { value: show.japanese_title, weight: 800 },
  ];
  let best = 0;
  for (const field of fields) {
    const value = publicTitleKey(field.value);
    if (!value) continue;
    if (value === needle) best = Math.max(best, field.weight);
    else if (value.startsWith(needle)) best = Math.max(best, field.weight - 100);
    else if (value.includes(needle)) best = Math.max(best, field.weight - 220);
  }
  return best;
}

function sortSearchShows(shows: PublicCatalogShow[], query = ""): PublicCatalogShow[] {
  return [...shows].sort((a, b) => {
    if (query) {
      const titleScoreA = searchTitleScore(a, query);
      const titleScoreB = searchTitleScore(b, query);
      if (titleScoreB !== titleScoreA) return titleScoreB - titleScoreA;
    }
    const popularityA = Number.isFinite(Number(a.popularity)) ? Number(a.popularity) : -1;
    const popularityB = Number.isFinite(Number(b.popularity)) ? Number(b.popularity) : -1;
    if (popularityB !== popularityA) return popularityB - popularityA;

    const ratingB = Number(b.rating || 0);
    const ratingA = Number(a.rating || 0);
    if (ratingB !== ratingA) return ratingB - ratingA;
    return String(a.title || '').localeCompare(String(b.title || ''), 'es', { sensitivity: 'base' });
  });
}

function mergePublicCatalogShow(existing: PublicCatalogShow, incoming: PublicCatalogShow): PublicCatalogShow {
  const aliases = [...new Set([
    ...(existing.title_aliases || []),
    ...(incoming.title_aliases || []),
    existing.title,
    incoming.title,
    existing.original_title,
    incoming.original_title,
    existing.english_title,
    incoming.english_title,
    existing.japanese_title,
    incoming.japanese_title,
  ].filter((value): value is string => Boolean(String(value || "").trim())))];
  return {
    ...existing,
    // Keep the Spanish request's display title when it arrived first, while
    // retaining the English/original variants for search and subtitle lookup.
    title_aliases: aliases,
    original_title: existing.original_title || incoming.original_title || null,
    original_language: existing.original_language || incoming.original_language || null,
    english_title: existing.english_title || incoming.english_title || null,
    japanese_title: existing.japanese_title || incoming.japanese_title || null,
    description: existing.description || incoming.description,
    synopsis: existing.synopsis || incoming.synopsis,
    poster_url: existing.poster_url || incoming.poster_url,
    banner_url: existing.banner_url || incoming.banner_url,
    backdrop_url: existing.backdrop_url || incoming.backdrop_url,
    poster_path: existing.poster_path || incoming.poster_path,
    backdrop_path: existing.backdrop_path || incoming.backdrop_path,
    rating: Math.max(Number(existing.rating || 0), Number(incoming.rating || 0)),
    popularity: Math.max(Number(existing.popularity || 0), Number(incoming.popularity || 0)),
  };
}

export function parseUniversalCatalogQuery(
  rawInput: unknown,
  explicitYear?: number | null
): ParsedCatalogQuery {
  const raw = String(rawInput || "").trim();
  const stripped = raw.replace(/\s+/g, "");

  // 1. IMDb ID detection
  const imdbMatch = /^(?:imdb[:#-]?)?(tt\d{5,12})$/i.exec(stripped);
  if (imdbMatch) {
    return {
      type: "imdb",
      raw,
      imdbId: imdbMatch[1].toLowerCase(),
      year: explicitYear || null,
    };
  }

  // 2. TMDB ID detection
  const tmdbMatch = /^(?:tmdb[:#-]?)?(\d{1,10})$/i.exec(stripped);
  if (tmdbMatch) {
    const tmdbId = Number.parseInt(tmdbMatch[1], 10);
    if (Number.isInteger(tmdbId) && tmdbId > 0) {
      return {
        type: "tmdb",
        raw,
        tmdbId,
        year: explicitYear || null,
      };
    }
  }

  // 3. TVDB ID detection
  const tvdbMatch = /^(?:tvdb[:#-])(\d{1,12})$/i.exec(stripped);
  if (tvdbMatch) {
    const tvdbId = Number.parseInt(tvdbMatch[1], 10);
    if (Number.isInteger(tvdbId) && tvdbId > 0) {
      return {
        type: "tvdb",
        raw,
        tvdbId,
        year: explicitYear || null,
      };
    }
  }

  // 4. Title (+ optional Year) parsing
  let parsedYear = Number.isInteger(Number(explicitYear)) && Number(explicitYear) > 1800
    ? Number(explicitYear)
    : null;
  let parsedTitle = raw;

  if (!parsedYear) {
    // Pattern 1: Title followed by (YYYY) or [YYYY]
    const yearBracketMatch = /(?:^|\s+)[\(\[]((?:19|20)\d{2})[\)\]]\s*$/i.exec(raw);
    if (yearBracketMatch) {
      parsedYear = Number.parseInt(yearBracketMatch[1], 10);
      parsedTitle = raw.replace(/(?:^|\s+)[\(\[]((?:19|20)\d{2})[\)\]]\s*$/i, "").trim();
    } else {
      // Pattern 2: Title followed by trailing 4-digit year (e.g. "The Conjuring 2013")
      const trailingYearMatch = /(?:^|\s+)((?:19|20)\d{2})\s*$/i.exec(raw);
      if (trailingYearMatch && trailingYearMatch.index > 0) {
        parsedYear = Number.parseInt(trailingYearMatch[1], 10);
        parsedTitle = raw.slice(0, trailingYearMatch.index).trim();
      }
    }
  }

  if (!parsedTitle) {
    parsedTitle = raw;
  }

  return {
    type: "title",
    raw,
    title: parsedTitle,
    year: parsedYear,
  };
}

export function parsePublicCatalogIdentifier(value: unknown): { tmdbId?: number; imdbId?: string; tvdbId?: number } | null {
  const query = parseUniversalCatalogQuery(value);
  if (query.type === "tmdb" && query.tmdbId) return { tmdbId: query.tmdbId };
  if (query.type === "imdb" && query.imdbId) return { imdbId: query.imdbId };
  if (query.type === "tvdb" && query.tvdbId) return { tvdbId: query.tvdbId };
  return null;
}

export function candidateToPublicCatalogShow(candidate: CatalogLookupCandidate): PublicCatalogShow {
  const kind: PublicCatalogKind = candidate.kind || (candidate.media_type === "movie" ? "movie" : "series");
  return {
    id: `tmdb-${kind}-${candidate.tmdb_id}`,
    title: candidate.title,
    tmdb_id: candidate.tmdb_id,
    imdb_id: candidate.imdb_id,
    anilist_id: null,
    mal_id: null,
    kitsu_id: null,
    title_aliases: candidate.original_title ? [candidate.title, candidate.original_title] : [candidate.title],
    kind,
    category: kind,
    original_title: candidate.original_title,
    original_language: null,
    english_title: null,
    japanese_title: null,
    description: candidate.overview,
    synopsis: candidate.overview,
    poster_url: candidate.poster_url,
    logo_url: null,
    banner_url: candidate.backdrop_path ? imageUrl(candidate.backdrop_path, "w780") : candidate.poster_url,
    backdrop_url: candidate.backdrop_path ? imageUrl(candidate.backdrop_path, "w780") : candidate.poster_url,
    poster_path: candidate.poster_path,
    backdrop_path: candidate.backdrop_path,
    rating: candidate.vote_average,
    popularity: candidate.popularity,
    year: candidate.year,
    genres: candidate.genres,
    episode_count: 0,
    sources: { master_m3u8: "", fallback_mp4: null, qualities: [], subtitles: [] },
  };
}

export async function searchPublicCatalogExternal(
  parsed: ParsedCatalogQuery,
  options: {
    kind?: unknown;
    year?: number | null;
    limit?: number;
    apiKey?: string;
  } = {}
): Promise<CatalogLookupResult> {
  const kind = parseKind(options.kind);
  const targetYear = options.year || parsed.year || null;
  const limit = Math.max(1, Math.min(50, options.limit || 20));
  const apiKey = options.apiKey;

  // 1. Path A: Exact IMDb ID
  if (parsed.type === "imdb" && parsed.imdbId) {
    const findRes = await tmdbFetch<TmdbFindResponse>(`/find/${parsed.imdbId}`, {
      external_source: "imdb_id",
      language: "es-419",
    }, apiKey);

    const candidates: CatalogLookupCandidate[] = [];
    const shows: PublicCatalogShow[] = [];

    const movieItems = kind === "series" ? [] : (findRes.movie_results || []);
    const tvItems = kind === "movie" ? [] : (findRes.tv_results || []);

    for (const item of movieItems) {
      const show = mapTmdbItem(item, isAnimeItem(item) ? "anime" : "movie");
      show.imdb_id = parsed.imdbId;
      shows.push(show);
      candidates.push({
        tmdb_id: item.id,
        imdb_id: parsed.imdbId,
        title: titleFrom(item),
        original_title: item.original_title || null,
        media_type: "movie",
        kind: show.kind,
        category: show.kind,
        year: yearFrom(item),
        poster_path: item.poster_path || null,
        poster_url: imageUrl(item.poster_path),
        backdrop_path: item.backdrop_path || null,
        overview: item.overview || "",
        vote_average: item.vote_average || 0,
        genres: genreNames(item),
        confidence: 1.0,
        popularity: item.popularity,
      });
    }

    for (const item of tvItems) {
      const show = mapTmdbItem(item, isAnimeItem(item) ? "anime" : "series");
      show.imdb_id = parsed.imdbId;
      shows.push(show);
      candidates.push({
        tmdb_id: item.id,
        imdb_id: parsed.imdbId,
        title: titleFrom(item),
        original_title: item.original_name || null,
        media_type: "tv",
        kind: show.kind,
        category: show.kind,
        year: yearFrom(item),
        poster_path: item.poster_path || null,
        poster_url: imageUrl(item.poster_path),
        backdrop_path: item.backdrop_path || null,
        overview: item.overview || "",
        vote_average: item.vote_average || 0,
        genres: genreNames(item),
        confidence: 1.0,
        popularity: item.popularity,
      });
    }

    return {
      ok: true,
      query: parsed.raw,
      exact_match: candidates.length > 0,
      candidates,
      shows,
    };
  }

  // 2. Path B: Exact TMDB ID
  if (parsed.type === "tmdb" && parsed.tmdbId) {
    const tmdbId = parsed.tmdbId;
    const fetchPromises = [];
    if (kind === "all" || kind === "movie") {
      fetchPromises.push(
        tmdbFetch<TmdbDetail>(`/movie/${tmdbId}`, {
          language: "es-419",
          append_to_response: "external_ids,translations",
        }, apiKey).then((detail) => ({ kind: "movie" as const, detail }))
      );
    }
    if (kind === "all" || kind === "series" || kind === "anime") {
      fetchPromises.push(
        tmdbFetch<TmdbDetail>(`/tv/${tmdbId}`, {
          language: "es-419",
          append_to_response: "external_ids,translations",
        }, apiKey).then((detail) => ({ kind: "series" as const, detail }))
      );
    }

    const settled = await Promise.allSettled(fetchPromises);
    const candidates: CatalogLookupCandidate[] = [];
    const shows: PublicCatalogShow[] = [];

    for (const res of settled) {
      if (res.status !== "fulfilled") continue;
      const detail = applySpanishTranslation(res.value.detail);
      const isAnime = isAnimeItem(detail);
      const outputKind: PublicCatalogKind = isAnime ? "anime" : res.value.kind;
      const show = mapTmdbItem(detail, outputKind);
      show.imdb_id = detail.external_ids?.imdb_id || null;
      shows.push(show);

      candidates.push({
        tmdb_id: detail.id,
        imdb_id: detail.external_ids?.imdb_id || null,
        title: titleFrom(detail),
        original_title: detail.original_title || detail.original_name || null,
        media_type: res.value.kind === "movie" ? "movie" : "tv",
        kind: outputKind,
        category: outputKind,
        year: yearFrom(detail),
        poster_path: detail.poster_path || null,
        poster_url: imageUrl(detail.poster_path),
        backdrop_path: detail.backdrop_path || null,
        overview: detail.overview || "",
        vote_average: detail.vote_average || 0,
        genres: genreNames(detail),
        confidence: 1.0,
        popularity: detail.popularity,
      });
    }

    return {
      ok: true,
      query: parsed.raw,
      exact_match: candidates.length > 0,
      candidates,
      shows,
    };
  }

  // 3. Path C: Exact TVDB ID via find
  if (parsed.type === "tvdb" && parsed.tvdbId) {
    const findRes = await tmdbFetch<TmdbFindResponse>(`/find/${parsed.tvdbId}`, {
      external_source: "tvdb_id",
      language: "es-419",
    }, apiKey);

    const candidates: CatalogLookupCandidate[] = [];
    const shows: PublicCatalogShow[] = [];

    const movieItems = kind === "series" ? [] : (findRes.movie_results || []);
    const tvItems = kind === "movie" ? [] : (findRes.tv_results || []);

    for (const item of movieItems) {
      const show = mapTmdbItem(item, isAnimeItem(item) ? "anime" : "movie");
      shows.push(show);
      candidates.push({
        tmdb_id: item.id,
        imdb_id: null,
        title: titleFrom(item),
        original_title: item.original_title || null,
        media_type: "movie",
        kind: show.kind,
        category: show.kind,
        year: yearFrom(item),
        poster_path: item.poster_path || null,
        poster_url: imageUrl(item.poster_path),
        backdrop_path: item.backdrop_path || null,
        overview: item.overview || "",
        vote_average: item.vote_average || 0,
        genres: genreNames(item),
        confidence: 1.0,
        popularity: item.popularity,
      });
    }

    for (const item of tvItems) {
      const show = mapTmdbItem(item, isAnimeItem(item) ? "anime" : "series");
      shows.push(show);
      candidates.push({
        tmdb_id: item.id,
        imdb_id: null,
        title: titleFrom(item),
        original_title: item.original_name || null,
        media_type: "tv",
        kind: show.kind,
        category: show.kind,
        year: yearFrom(item),
        poster_path: item.poster_path || null,
        poster_url: imageUrl(item.poster_path),
        backdrop_path: item.backdrop_path || null,
        overview: item.overview || "",
        vote_average: item.vote_average || 0,
        genres: genreNames(item),
        confidence: 1.0,
        popularity: item.popularity,
      });
    }

    return {
      ok: true,
      query: parsed.raw,
      exact_match: candidates.length > 0,
      candidates,
      shows,
    };
  }

  // 4. Path D: Title (+ optional Year) search across multi-language endpoints
  const searchTitle = parsed.title || parsed.raw;
  const searchLanguages = ["es-419", "es-ES", "en-US"];
  const paths: Array<{ path: string; media_type: "movie" | "tv" }> = [];

  if (kind === "all" || kind === "movie") {
    paths.push({ path: "/search/movie", media_type: "movie" });
  }
  if (kind === "all" || kind === "series" || kind === "anime") {
    paths.push({ path: "/search/tv", media_type: "tv" });
  }

  const searchCalls = paths.flatMap(({ path, media_type }) =>
    searchLanguages.map((language) =>
      tmdbFetch<TmdbListResponse>(path, {
        query: searchTitle,
        language,
        include_adult: "false",
        ...(targetYear && media_type === "movie" ? { primary_release_year: targetYear } : {}),
        ...(targetYear && media_type === "tv" ? { first_air_date_year: targetYear } : {}),
      }, apiKey)
        .then((res) => ({ media_type, results: res.results || [] }))
        .catch(() => ({ media_type, results: [] }))
    )
  );

  const initialBatches = await Promise.all(searchCalls);
  let aggregated = initialBatches.flatMap((b) => b.results.map((item) => ({ media_type: b.media_type, item })));

  if (targetYear && aggregated.length === 0) {
    const unconstrainedCalls = paths.flatMap(({ path, media_type }) =>
      searchLanguages.map((language) =>
        tmdbFetch<TmdbListResponse>(path, {
          query: searchTitle,
          language,
          include_adult: "false",
        }, apiKey)
          .then((res) => ({ media_type, results: res.results || [] }))
          .catch(() => ({ media_type, results: [] }))
      )
    );
    const retryBatches = await Promise.all(unconstrainedCalls);
    aggregated = retryBatches.flatMap((b) => b.results.map((item) => ({ media_type: b.media_type, item })));
  }

  // Deduplicate and aggregate aliases
  const candidateMap = new Map<string, { media_type: "movie" | "tv"; item: TmdbItem; aliases: Set<string> }>();
  for (const entry of aggregated) {
    const key = `${entry.media_type}:${entry.item.id}`;
    const existing = candidateMap.get(key);
    if (!existing) {
      candidateMap.set(key, {
        media_type: entry.media_type,
        item: entry.item,
        aliases: new Set([titleFrom(entry.item), entry.item.original_title, entry.item.original_name].filter(Boolean) as string[]),
      });
    } else {
      if (entry.item.title) existing.aliases.add(entry.item.title);
      if (entry.item.name) existing.aliases.add(entry.item.name);
      if (entry.item.original_title) existing.aliases.add(entry.item.original_title);
      if (entry.item.original_name) existing.aliases.add(entry.item.original_name);
    }
  }

  // Score and rank candidates
  const scoredCandidates: Array<{ candidate: CatalogLookupCandidate; show: PublicCatalogShow }> = [];
  const normalizedQuery = publicTitleKey(searchTitle);

  for (const { media_type, item, aliases } of candidateMap.values()) {
    const isAnime = isAnimeItem(item);
    const outputKind: PublicCatalogKind = isAnime ? "anime" : (media_type === "movie" ? "movie" : "series");
    if (kind !== "all" && kind !== outputKind) continue;

    const itemYear = yearFrom(item);
    const candidateTitle = titleFrom(item);

    // Title score
    let titleScore = 0.2;
    for (const alias of aliases) {
      const normAlias = publicTitleKey(alias);
      if (normAlias === normalizedQuery) {
        titleScore = Math.max(titleScore, 1.0);
      } else if (normAlias.startsWith(normalizedQuery)) {
        titleScore = Math.max(titleScore, 0.88);
      } else if (normAlias.includes(normalizedQuery)) {
        titleScore = Math.max(titleScore, 0.75);
      }
    }

    // Year score
    let yearScore = 1.0;
    if (targetYear && itemYear) {
      const diff = Math.abs(itemYear - targetYear);
      if (diff === 0) yearScore = 1.0;
      else if (diff === 1) yearScore = 0.80;
      else if (diff <= 3) yearScore = 0.40;
      else yearScore = 0.10;
    } else if (targetYear && !itemYear) {
      yearScore = 0.50;
    }

    // Popularity score
    const popularity = Number(item.popularity || 0);
    const popScore = Math.min(1.0, Math.log10(popularity + 1) / 3.0);

    let confidence: number;
    if (targetYear) {
      confidence = (titleScore * 0.65) + (yearScore * 0.25) + (popScore * 0.10);
    } else {
      confidence = (titleScore * 0.85) + (popScore * 0.15);
    }
    if (titleScore === 1.0 && yearScore === 1.0) confidence = 1.0;
    confidence = Math.min(1.0, Math.max(0.05, Math.round(confidence * 100) / 100));

    const show = mapTmdbItem(item, outputKind);
    show.title_aliases = [...aliases];

    const candidate: CatalogLookupCandidate = {
      tmdb_id: item.id,
      imdb_id: null,
      title: candidateTitle,
      original_title: item.original_title || item.original_name || null,
      media_type,
      kind: outputKind,
      category: outputKind,
      year: itemYear,
      poster_path: item.poster_path || null,
      poster_url: imageUrl(item.poster_path),
      backdrop_path: item.backdrop_path || null,
      overview: item.overview || "",
      vote_average: item.vote_average || 0,
      genres: genreNames(item),
      confidence,
      popularity,
    };

    scoredCandidates.push({ candidate, show });
  }

  // Sort by confidence desc, popularity desc
  scoredCandidates.sort((a, b) => {
    if (b.candidate.confidence !== a.candidate.confidence) {
      return b.candidate.confidence - a.candidate.confidence;
    }
    return (b.candidate.popularity || 0) - (a.candidate.popularity || 0);
  });

  const sliced = scoredCandidates.slice(0, limit);

  // Backfill canonical imdb_id for top 5 candidates in parallel
  const topForImdb = sliced.slice(0, 5);
  await Promise.allSettled(
    topForImdb.map(async ({ candidate, show }) => {
      try {
        const ext = await tmdbFetch<{ imdb_id?: string | null }>(
          `/${candidate.media_type}/${candidate.tmdb_id}/external_ids`,
          {},
          apiKey
        );
        if (ext?.imdb_id) {
          candidate.imdb_id = ext.imdb_id;
          show.imdb_id = ext.imdb_id;
        }
      } catch {
        // Non-fatal enhancement
      }
    })
  );

  const candidates = sliced.map((s) => s.candidate);
  const shows = sliced.map((s) => s.show);
  const exactMatch = candidates.length > 0 && candidates[0].confidence >= 0.95;

  return {
    ok: true,
    query: parsed.raw,
    exact_match: exactMatch,
    candidates,
    shows,
  };
}

/** Resolve an exact TMDB or IMDb identifier without consulting provider rows. */
export async function getPublicCatalogByIdentifier(value: unknown, apiKey?: string): Promise<PublicCatalogResult | null> {
  const identifier = parsePublicCatalogIdentifier(value);
  if (!identifier) return null;

  const shows: PublicCatalogShow[] = [];
  if (identifier.tmdbId) {
    const responses = await Promise.allSettled([
      tmdbFetch<TmdbDetail>(`/movie/${identifier.tmdbId}`, {
        language: 'es-419',
        append_to_response: 'external_ids',
      }, apiKey),
      tmdbFetch<TmdbDetail>(`/tv/${identifier.tmdbId}`, {
        language: 'es-419',
        append_to_response: 'external_ids',
      }, apiKey),
    ]);
    for (const [index, response] of responses.entries()) {
      if (response.status !== 'fulfilled') continue;
      const detail = applySpanishTranslation(response.value);
      const kind: PublicCatalogKind = index === 0
        ? (isAnimeItem(detail) ? 'anime' : 'movie')
        : (isAnimeItem(detail) ? 'anime' : 'series');
      const show = mapTmdbItem(detail, kind);
      show.imdb_id = detail.external_ids?.imdb_id || null;
      shows.push(show);
    }
  } else if (identifier.imdbId || identifier.tvdbId) {
    const externalId = identifier.imdbId || String(identifier.tvdbId);
    const externalSource = identifier.imdbId ? 'imdb_id' : 'tvdb_id';
    const result = await tmdbFetch<TmdbFindResponse>(`/find/${externalId}`, {
      external_source: externalSource,
      language: 'es-419',
    }, apiKey);
    for (const item of result.movie_results || []) {
      const show = mapTmdbItem(item, isAnimeItem(item) ? 'anime' : 'movie');
      show.imdb_id = identifier.imdbId || null;
      shows.push(show);
    }
    for (const item of result.tv_results || []) {
      const show = mapTmdbItem(item, isAnimeItem(item) ? 'anime' : 'series');
      show.imdb_id = identifier.imdbId || null;
      shows.push(show);
    }
  }

  const unique = new Map<string, PublicCatalogShow>();
  for (const show of shows) {
    const key = `${show.kind === 'movie' ? 'movie' : 'tv'}:${show.tmdb_id}`;
    if (!unique.has(key)) unique.set(key, show);
  }
  const ordered = sortSearchShows([...unique.values()]);
  return {
    shows: ordered,
    total: ordered.length,
    page: 1,
    pageSize: Math.max(1, ordered.length),
    totalPages: 1,
    nextPage: 2,
    source: 'tmdb',
  };
}

async function fetchList(kind: PublicCatalogKind, query: string, page: number, mode: string, genreId?: number | null, tvGenreId?: number | null, apiKey?: string, requestedLanguage = "es-419"): Promise<TmdbListResponse> {
  const language = requestedLanguage;
  if (query) {
    const path = kind === "movie" ? "/search/movie" : "/search/tv";
    return tmdbFetch<TmdbListResponse>(path, { query, page, language, include_adult: "false" }, apiKey);
  }
  if (kind === "movie") {
    return tmdbFetch<TmdbListResponse>(mode === "discover" ? "/discover/movie" : "/trending/movie/week", mode === "discover"
      ? { page, language, sort_by: "popularity.desc", include_adult: "false", ...(genreId ? { with_genres: genreId } : {}) }
      : { page, language }, apiKey);
  }
  if (kind === "anime") {
    return tmdbFetch<TmdbListResponse>("/discover/tv", {
      page,
      language,
      sort_by: "popularity.desc",
      with_genres: tvGenreId && tvGenreId !== 16 ? `16,${tvGenreId}` : "16",
      with_original_language: "ja",
      include_adult: "false",
    }, apiKey);
  }
  return tmdbFetch<TmdbListResponse>(mode === "discover" ? "/discover/tv" : "/trending/tv/week", mode === "discover"
    ? { page, language, sort_by: "popularity.desc", include_adult: "false", ...(tvGenreId ? { with_genres: tvGenreId } : {}) }
    : { page, language }, apiKey);
}

export async function getPublicCatalog(options: {
  kind?: unknown;
  query?: unknown;
  page?: number;
  limit?: number;
  mode?: string;
  genre?: unknown;
  apiKey?: string;
} = {}): Promise<PublicCatalogResult> {
  const kind = parseKind(options.kind);
  const query = String(options.query || "").trim().slice(0, 120);
  const page = Math.max(1, Math.min(500, Number(options.page || 1)));
  const pageSize = Math.max(1, Math.min(100, Number(options.limit || 40)));
  const parsedGenre = Number(options.genre);
  const genreId = Number.isInteger(parsedGenre) && parsedGenre > 0 ? parsedGenre : null;
  const tvGenreId = genreId ? TV_GENRE_IDS_BY_MOVIE_GENRE[genreId] || genreId : null;
  // A genre is a TMDB discover constraint. Ignore trending when one is
  // present so the selected category can be paginated beyond the weekly rail.
  const mode = genreId ? "discover" : options.mode === "discover" ? "discover" : "trending";
  const kinds: PublicCatalogKind[] = kind === "all" ? ["movie", "series", "anime"] : [kind];
  // TMDB currently returns 20 rows per page even when the UI asks for 40–100.
  // Fetch just enough adjacent pages to fill the requested rail; otherwise the
  // public catalog silently stops at the first 20 anime and makes the legacy
  // database look more complete than the canonical TMDB catalog.
  const pagesNeeded = Math.max(1, Math.min(5, Math.ceil(pageSize / 20)));
  const searchLanguages = query ? ["es-419", "en-US"] : ["es-419"];
  const groupedResponses = await Promise.all(kinds.map(async (entry) => ({
    kind: entry,
    // Spanish remains the primary ranked feed. One English page is enough to
    // recover a title alias in the common TMDB/IMDb mismatch case without
    // doubling every pagination request.
    pages: await Promise.all(searchLanguages.flatMap((language) => Array.from({ length: language === "en-US" ? 1 : pagesNeeded }, (_unused, offset) =>
      fetchList(entry, query, page + offset, mode, genreId, tvGenreId, options.apiKey, language)))),
  })));
  const mappedShows = groupedResponses.flatMap(({ kind: entryKind, pages }) => pages.flatMap((response) => {
    const results = response.results || [];
    const filtered = entryKind === "anime"
      ? results.filter(isAnimeItem)
      : entryKind === "series" && kind !== "series"
        ? results.filter((item) => !isAnimeItem(item))
        : entryKind === "series"
          ? results.filter((item) => !isAnimeItem(item))
          : results;
    // Never relabel an ordinary TV result as anime merely because the anime
    // search bucket had no exact match. The old fallback duplicated Korean and
    // other live-action dramas into the Anime rail and sent the wrong kind to
    // identity/provider matching.
    return filtered.map((item) => {
      const outputKind: PublicCatalogKind = kind === "all" && entryKind === "series" && isAnimeItem(item)
        ? "anime"
        : entryKind;
      return mapTmdbItem(item, outputKind, !query && mode === "trending");
    });
  }));
  const shows = await repairTmdbPosters(mappedShows);
  const uniqueMap = new Map<string, PublicCatalogShow>();
  for (const show of shows) {
    const namespace = show.kind === "movie" ? "movie" : "tv";
    const key = `${namespace}:${show.tmdb_id}`;
    const previous = uniqueMap.get(key);
    if (!previous || (show.kind === "anime" && previous.kind === "series")) uniqueMap.set(key, show);
    else uniqueMap.set(key, mergePublicCatalogShow(previous, show));
  }
  const unique = dedupePoorPublicDuplicates([...uniqueMap.values()]);
  const ordered = query
    ? sortSearchShows(unique, query)
    : kind === "all" ? interleaveCatalogShows(unique) : unique;
  // Search runs once in Spanish and once in English to recover titles that
  // differ between TMDB/IMDb. The merged TMDB identity count is the only
  // meaningful total; summing both language responses would double it.
  const totals = query
    ? unique.length
    : groupedResponses.reduce((sum, group) => {
        const firstPage = group.pages[0];
        return sum + Number(firstPage?.total_results || firstPage?.results?.length || 0);
      }, 0);
  // `page` is a TMDB page cursor (20 results), even when this endpoint
  // aggregates three pages into a 60-item response. Expose the upstream page
  // count so category-specific "Cargar más" buttons can stop at the real
  // boundary instead of treating 60 as one TMDB page.
  const upstreamTotalPages = Math.max(1, ...groupedResponses.map((group) => Number(group.pages[0]?.total_pages || 1)));
  return {
    shows: ordered.slice(0, pageSize),
    total: totals,
    page,
    pageSize,
    totalPages: upstreamTotalPages,
    nextPage: page + pagesNeeded,
    source: "tmdb",
  };
}

export async function getPublicCatalogDetail(kindValue: unknown, tmdbIdValue: unknown, apiKey?: string): Promise<PublicCatalogDetail | null> {
  const kind = parseKind(kindValue);
  const tmdbId = Number.parseInt(String(tmdbIdValue || ""), 10);
  if (kind === "all" || !Number.isInteger(tmdbId) || tmdbId <= 0) return null;
  let detail: TmdbDetail;
  let isMovieDetail = kind === "movie";
  try {
    detail = await tmdbFetch<TmdbDetail>(kind === "movie" ? `/movie/${tmdbId}` : `/tv/${tmdbId}`, {
      language: "es-419",
      append_to_response: "external_ids,translations,images",
      include_image_language: "es,en,null",
    }, apiKey);
  } catch (error) {
    // TMDB stores anime films under /movie while the public rail uses the
    // unified "anime" kind. Retry that namespace before declaring the title
    // missing so a movie such as Gundam Hathaway keeps its canonical ID and
    // gets the same virtual S01E01 contract as other one-off releases.
    if (kind !== "anime") throw error;
    detail = await tmdbFetch<TmdbDetail>(`/movie/${tmdbId}`, {
      language: "es-419",
      append_to_response: "external_ids,translations,images",
      include_image_language: "es,en,null",
    }, apiKey);
    isMovieDetail = true;
  }
  detail = applySpanishTranslation(detail);
  const show = mapTmdbItem(detail, kind);
  show.logo_url = tmdbLogoUrl(detail);
  show.imdb_id = detail.external_ids?.imdb_id || null;
  if (kind === "anime") {
    const identity = await fetchAnimeIdentity(show.tmdb_id, show.title, show.original_title);
    show.anilist_id = identity.anilistId;
    show.mal_id = identity.malId;
    show.kitsu_id = identity.kitsuId;
    show.title_aliases = [...new Set([...(show.title_aliases || []), ...identity.aliases])];
  }
  const episodes: PublicCatalogEpisode[] = [];
  if (kind === "movie" || isMovieDetail) {
    episodes.push({
      id: `tmdb-movie-${tmdbId}-s1-e1`,
      show_id: show.id,
      title: show.title,
      episode_number: 1,
      season_number: 1,
      source_url: `tmdb://${kind}/${tmdbId}/1/1`,
    });
  } else {
    const seasons = (detail.seasons || [])
      // The playback gateway uses positive season coordinates. Keep TMDB
      // specials out of the public episode grid until a dedicated specials
      // contract exists, so a click can never silently become S01E01.
      .filter((season) => Number.isInteger(season.season_number) && season.season_number >= 1 && season.episode_count > 0)
      .slice(0, 50);
    for (const season of seasons) {
      const seasonNumber = season.season_number;
      for (let episodeNumber = 1; episodeNumber <= Math.min(500, season.episode_count); episodeNumber++) {
        episodes.push({
          id: `tmdb-${kind}-${tmdbId}-s${seasonNumber}-e${episodeNumber}`,
          show_id: show.id,
          title: `Episodio ${episodeNumber}`,
          episode_number: episodeNumber,
          season_number: seasonNumber,
          source_url: `tmdb://${kind}/${tmdbId}/${seasonNumber}/${episodeNumber}`,
        });
      }
    }
  }
  show.episode_count = episodes.filter((episode) => episode.season_number > 0).length || episodes.length;
  return {
    ...show,
    episodes,
    external_ids: {
      imdb_id: detail.external_ids?.imdb_id || null,
      tvdb_id: detail.external_ids?.tvdb_id || null,
      wikidata_id: detail.external_ids?.wikidata_id || null,
    },
  };
}

/** Related titles for the detail sheet. Keep this separate from the main
 * catalog so opening one title never expands the user's home payload. */
export async function getPublicCatalogRelated(kindValue: unknown, tmdbIdValue: unknown, apiKey?: string): Promise<PublicCatalogShow[]> {
  const kind = parseKind(kindValue);
  const tmdbId = Number.parseInt(String(tmdbIdValue || ""), 10);
  if (kind === "all" || !Number.isInteger(tmdbId) || tmdbId <= 0) return [];

  const related = new Map<string, PublicCatalogShow>();

  // Anime can live in either TMDB namespace: episodic titles use /tv while
  // anime films use /movie. Start with the likely namespace and fall back to
  // the other one only when it produces no usable recommendation.
  const pathKinds = kind === "movie" ? ["movie"] : kind === "anime" ? ["tv", "movie"] : ["tv"];
  for (const pathKind of pathKinds) {
    const requests = [
      `/${pathKind}/${tmdbId}/recommendations`,
      `/${pathKind}/${tmdbId}/similar`,
    ];
    for (const path of requests) {
      try {
        const response = await tmdbFetch<TmdbListResponse>(path, {
          language: "es-419",
          page: 1,
        }, apiKey);
        for (const item of response.results || []) {
          if (!item?.id || item.id === tmdbId) continue;
          const mapped = mapTmdbItem(item, kind);
          const namespace = kind === "movie" ? "movie" : kind === "anime" ? "anime" : "series";
          const key = `${namespace}:${item.id}`;
          if (!related.has(key)) related.set(key, mapped);
        }
        if (related.size >= 12) break;
      } catch {
        // Recommendations are an enhancement; a missing related rail must not
        // make the actual title detail fail.
      }
    }
    if (related.size >= 12) break;
  }

  const repaired = await repairTmdbPosters([...related.values()].slice(0, 18));
  return repaired.slice(0, 12);
}

export function resetPublicCatalogCache(): void {
  cache.clear();
}
