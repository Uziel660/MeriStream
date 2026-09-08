/**
 * TMDB-backed public catalog.
 *
 * The catalog is intentionally independent from the imported provider tables:
 * a card is identified by its TMDB namespace and providers are resolved later
 * by the gateway. This keeps a stale or incomplete scraper import from hiding
 * a title that TMDB knows about.
 */

export type PublicCatalogKind = "movie" | "series" | "anime";

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
  english_title?: string | null;
  japanese_title?: string | null;
  description: string;
  synopsis: string;
  poster_url: string;
  banner_url: string;
  backdrop_url: string;
  poster_path: string | null;
  backdrop_path: string | null;
  rating: number;
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

type TmdbDetail = TmdbItem & {
  external_ids?: {
    imdb_id?: string | null;
    tvdb_id?: number | null;
    wikidata_id?: string | null;
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

function imageUrl(path: string | null | undefined, size: "w500" | "w780" = "w500"): string {
  return path ? `${IMAGE_BASE}/${size}${path}` : "";
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
    english_title: item.original_language === "en" ? originalTitle : null,
    japanese_title: item.original_language === "ja" ? originalTitle : null,
    description: String(item.overview || ""),
    synopsis: String(item.overview || ""),
    poster_url: poster,
    banner_url: backdrop,
    backdrop_url: backdrop,
    poster_path: item.poster_path || null,
    backdrop_path: item.backdrop_path || null,
    rating: Number.isFinite(Number(item.vote_average)) ? Number(item.vote_average) : 0,
    year: yearFrom(item),
    genres: genreNames(item),
    episode_count: Number(item.number_of_episodes || 0),
    is_trending: isTrending,
    status: item.status || null,
    sources: { master_m3u8: "", fallback_mp4: null, qualities: [], subtitles: [] },
  };
}

async function fetchAnimeIdentity(title: string, originalTitle?: string | null): Promise<AnimeIdentity> {
  const search = String(title || originalTitle || "").trim();
  const empty: AnimeIdentity = { anilistId: null, malId: null, kitsuId: null, aliases: [] };
  if (!search) return empty;
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
    searchUrl.searchParams.set("page[limit]", "1");
    const response = await fetch(searchUrl, {
      headers: { Accept: "application/vnd.api+json", "User-Agent": "MeriStream/1.0" },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return empty;
    const payload = await response.json() as any;
    const anime = payload?.data?.[0];
    if (!anime) return empty;
    const mappingsResponse = await fetch(`https://kitsu.io/api/edge/anime/${encodeURIComponent(String(anime.id))}/mappings`, {
      headers: { Accept: "application/vnd.api+json", "User-Agent": "MeriStream/1.0" },
      signal: AbortSignal.timeout(6_000),
    });
    const mappingsPayload = mappingsResponse.ok ? await mappingsResponse.json() as any : null;
    const mappings = Array.isArray(mappingsPayload?.data) ? mappingsPayload.data : [];
    const mal = mappings.find((entry: any) => entry?.attributes?.externalSite === "myanimelist/anime")?.attributes?.externalId;
    const anilist = mappings.find((entry: any) => entry?.attributes?.externalSite === "anilist/anime")?.attributes?.externalId;
    const attributes = anime.attributes || {};
    const aliases = [attributes.canonicalTitle, attributes.titles?.en, attributes.titles?.en_jp, attributes.titles?.ja_jp]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    const value: AnimeIdentity = {
      anilistId: anilist ? String(anilist) : null,
      malId: mal && /^\d+$/.test(String(mal)) ? Number(mal) : null,
      kitsuId: String(anime.id),
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

async function tmdbFetch<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("TMDB_API_KEY no configurada");
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const cacheKey = url.toString().replace(/([?&])api_key=[^&]+/, "$1api_key=redacted");
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value as T;
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "MeriStream/1.0" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`TMDB HTTP ${response.status}`);
  const value = await response.json() as T;
  cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, value });
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

async function fetchList(kind: PublicCatalogKind, query: string, page: number, mode: string): Promise<TmdbListResponse> {
  const language = "es-419";
  if (query) {
    const path = kind === "movie" ? "/search/movie" : "/search/tv";
    return tmdbFetch<TmdbListResponse>(path, { query, page, language, include_adult: "false" });
  }
  if (kind === "movie") {
    return tmdbFetch<TmdbListResponse>(mode === "discover" ? "/discover/movie" : "/trending/movie/week", mode === "discover"
      ? { page, language, sort_by: "popularity.desc", include_adult: "false" }
      : { language });
  }
  if (kind === "anime") {
    return tmdbFetch<TmdbListResponse>("/discover/tv", {
      page,
      language,
      sort_by: "popularity.desc",
      with_genres: "16",
      with_original_language: "ja",
      include_adult: "false",
    });
  }
  return tmdbFetch<TmdbListResponse>(mode === "discover" ? "/discover/tv" : "/trending/tv/week", mode === "discover"
    ? { page, language, sort_by: "popularity.desc", include_adult: "false" }
    : { language });
}

export async function getPublicCatalog(options: {
  kind?: unknown;
  query?: unknown;
  page?: number;
  limit?: number;
  mode?: string;
} = {}): Promise<PublicCatalogResult> {
  const kind = parseKind(options.kind);
  const query = String(options.query || "").trim().slice(0, 120);
  const page = Math.max(1, Math.min(500, Number(options.page || 1)));
  const pageSize = Math.max(1, Math.min(100, Number(options.limit || 40)));
  const mode = options.mode === "discover" ? "discover" : "trending";
  const kinds: PublicCatalogKind[] = kind === "all" ? ["movie", "series", "anime"] : [kind];
  const responses = await Promise.all(kinds.map((entry) => fetchList(entry, query, page, mode)));
  const shows = responses.flatMap((response, index) => {
    const entryKind = kinds[index];
    const results = response.results || [];
    const filtered = entryKind === "anime"
      ? results.filter(isAnimeItem)
      : entryKind === "series" && kind !== "series"
        ? results
        : entryKind === "series"
          ? results.filter((item) => !isAnimeItem(item))
          : results;
    // An exact anime search can be absent from TMDB's genre tags. Returning the
    // TV result is more useful than an empty search; the gateway still uses the
    // canonical TMDB id for playback.
    const effective = filtered.length || entryKind !== "anime" || !query ? filtered : results;
    return effective.map((item) => {
      const outputKind: PublicCatalogKind = kind === "all" && entryKind === "series" && isAnimeItem(item)
        ? "anime"
        : entryKind;
      return mapTmdbItem(item, outputKind, !query && mode === "trending");
    });
  });
  const uniqueMap = new Map<string, PublicCatalogShow>();
  for (const show of shows) {
    const namespace = show.kind === "movie" ? "movie" : "tv";
    const key = `${namespace}:${show.tmdb_id}`;
    const previous = uniqueMap.get(key);
    if (!previous || (show.kind === "anime" && previous.kind === "series")) uniqueMap.set(key, show);
  }
  const unique = [...uniqueMap.values()];
  const totals = responses.reduce((sum, response) => sum + Number(response.total_results || response.results?.length || 0), 0);
  return {
    shows: unique.slice(0, pageSize),
    total: totals,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(totals / pageSize)),
    source: "tmdb",
  };
}

export async function getPublicCatalogDetail(kindValue: unknown, tmdbIdValue: unknown): Promise<PublicCatalogDetail | null> {
  const kind = parseKind(kindValue);
  const tmdbId = Number.parseInt(String(tmdbIdValue || ""), 10);
  if (kind === "all" || !Number.isInteger(tmdbId) || tmdbId <= 0) return null;
  const detail = await tmdbFetch<TmdbDetail>(kind === "movie" ? `/movie/${tmdbId}` : `/tv/${tmdbId}`, {
    language: "es-419",
    append_to_response: "external_ids",
  });
  const show = mapTmdbItem(detail, kind);
  show.imdb_id = detail.external_ids?.imdb_id || null;
  if (kind === "anime") {
    const identity = await fetchAnimeIdentity(show.title, show.original_title);
    show.anilist_id = identity.anilistId;
    show.mal_id = identity.malId;
    show.kitsu_id = identity.kitsuId;
    show.title_aliases = [...new Set([...(show.title_aliases || []), ...identity.aliases])];
  }
  const episodes: PublicCatalogEpisode[] = [];
  if (kind === "movie") {
    episodes.push({
      id: `tmdb-movie-${tmdbId}-s1-e1`,
      show_id: show.id,
      title: show.title,
      episode_number: 1,
      season_number: 1,
      source_url: `tmdb://movie/${tmdbId}/1/1`,
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

export function resetPublicCatalogCache(): void {
  cache.clear();
}
