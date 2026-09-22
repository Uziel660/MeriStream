#!/usr/bin/env node
import "dotenv/config";
import { prisma, normalizeBaseTitle, normalizeTitle } from "../server/db";
import { PROVIDER_POLICIES } from "../server/providers/providerPolicy";

type MediaKind = "movie" | "series" | "anime";

type TmdbListItem = {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  original_language?: string;
  genre_ids?: number[];
  overview?: string;
  vote_average?: number;
  status?: string;
};

type TmdbListResponse = {
  page: number;
  total_pages: number;
  results: TmdbListItem[];
};

type TmdbTvDetails = {
  id: number;
  name?: string;
  original_name?: string;
  overview?: string;
  vote_average?: number;
  status?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  original_language?: string;
  genres?: Array<{ id: number; name: string }>;
  seasons?: Array<{
    season_number: number;
    episode_count: number;
  }>;
  external_ids?: { imdb_id?: string | null; tvdb_id?: number | null };
};

type TmdbMovieDetails = {
  id: number;
  title?: string;
  original_title?: string;
  overview?: string;
  vote_average?: number;
  status?: string;
  release_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  original_language?: string;
  genres?: Array<{ id: number; name: string }>;
  external_ids?: { imdb_id?: string | null; tvdb_id?: number | null };
};

type TmdbDetails = TmdbTvDetails | TmdbMovieDetails;

type AnimeIdentity = {
  anilist_id: string | null;
  mal_id: number | null;
  kitsu_id: string | null;
};

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p/w500";
const BACKDROP_BASE = "https://image.tmdb.org/t/p/original";
const ANIMATION_GENRE_ID = 16;

function readIntFlag(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${name} debe ser un entero >= 0`);
  }
  return parsed;
}

const MOVIE_TARGET = readIntFlag("movies", 250);
const SERIES_TARGET = readIntFlag("series", 100);
const ANIME_TARGET = readIntFlag("anime", 100);
const DRY_RUN = process.argv.includes("--dry-run");
const RESET = process.argv.includes("--reset");
const SKIP_EPISODES = process.argv.includes("--skip-episodes");
const REQUEST_DELAY_MS = readIntFlag("delay-ms", 90);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function yearFrom(value?: string): number | null {
  if (!value) return null;
  const year = Number.parseInt(value.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function titleOf(item: TmdbListItem): string {
  return String(item.title || item.name || item.original_title || item.original_name || "").trim();
}

function originalTitleOf(item: TmdbListItem): string | null {
  const value = String(item.original_title || item.original_name || "").trim();
  return value || null;
}

async function tmdb<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const apiKey = process.env.TMDB_API_KEY?.trim();
  if (!apiKey) throw new Error("TMDB_API_KEY no está configurado en .env");

  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", apiKey);
  // TMDB's Latin American localization is the public catalog contract. Keep
  // the original title separately so matching can still use Japanese/English.
  url.searchParams.set("language", "es-419");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`TMDB ${path} -> HTTP ${response.status}`);
  }
  const body = await response.json() as T;
  if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
  return body;
}

async function collect(path: string, target: number, params: Record<string, string | number> = {}): Promise<TmdbListItem[]> {
  if (target <= 0) return [];
  const output: TmdbListItem[] = [];
  const seen = new Set<number>();
  let page = 1;
  let totalPages = 1;

  while (output.length < target && page <= totalPages && page <= 500) {
    const payload = await tmdb<TmdbListResponse>(path, { ...params, page });
    totalPages = Math.max(1, payload.total_pages || 1);
    for (const item of payload.results || []) {
      if (!item?.id || seen.has(item.id) || !titleOf(item)) continue;
      seen.add(item.id);
      output.push(item);
      if (output.length >= target) break;
    }
    page += 1;
  }

  return output;
}

const detailsCache = new Map<string, TmdbDetails | null>();
const animeIdentityCache = new Map<string, AnimeIdentity>();

async function fetchDetails(kind: MediaKind, tmdbId: number): Promise<TmdbDetails | null> {
  const key = `${kind}:${tmdbId}`;
  if (detailsCache.has(key)) return detailsCache.get(key) || null;
  try {
    const path = kind === "movie" ? `/movie/${tmdbId}` : `/tv/${tmdbId}`;
    const value = await tmdb<TmdbDetails>(path, { append_to_response: "external_ids" });
    detailsCache.set(key, value);
    return value;
  } catch (error) {
    console.warn(`[bootstrap] TMDB detail omitido ${kind}/${tmdbId}: ${error instanceof Error ? error.message : error}`);
    detailsCache.set(key, null);
    return null;
  }
}

async function fetchAnimeIdentity(title: string, originalTitle?: string | null): Promise<AnimeIdentity> {
  const search = String(title || originalTitle || "").trim();
  const empty: AnimeIdentity = { anilist_id: null, mal_id: null, kitsu_id: null };
  if (!search) return empty;
  const key = search.toLowerCase();
  const cached = animeIdentityCache.get(key);
  if (cached) return cached;
  try {
    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "MeriStream/1.0" },
      body: JSON.stringify({
        query: "query ($search: String) { Media(search: $search, type: ANIME) { id idMal } }",
        variables: { search },
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) {
      const media = (await response.json() as any)?.data?.Media;
      if (media) {
        const identity = {
          anilist_id: media.id == null ? null : String(media.id),
          mal_id: Number.isInteger(Number(media.idMal)) ? Number(media.idMal) : null,
          kitsu_id: null,
        };
        animeIdentityCache.set(key, identity);
        return identity;
      }
    }
  } catch { /* identity is optional; playback can crosswalk via public TMDB detail */ }
  animeIdentityCache.set(key, empty);
  return empty;
}

async function seedProviderRatings(): Promise<number> {
  let changed = 0;
  for (const policy of Object.values(PROVIDER_POLICIES)) {
    if (policy.role === "metadata") continue;
    if (DRY_RUN) {
      changed += 1;
      continue;
    }
    await prisma.siteRating.upsert({
      where: { site: policy.id },
      create: {
        site: policy.id,
        rating: policy.defaultRating,
        enabled: policy.lifecycle !== "legacy",
        notes: `bootstrap:${policy.role}/${policy.lifecycle}; priority=${policy.priority}`,
      },
      update: {},
    });
    changed += 1;
  }
  return changed;
}

async function ensureEpisodeSkeleton(
  mediaItemId: string,
  kind: MediaKind,
  tmdbId: number,
  details?: TmdbDetails | null,
): Promise<number> {
  if (SKIP_EPISODES) return 0;

  if (kind === "movie") {
    if (!DRY_RUN) {
      await prisma.mediaEpisode.upsert({
        where: {
          media_item_id_season_number_episode_number: {
            media_item_id: mediaItemId,
            season_number: 1,
            episode_number: 1,
          },
        },
        create: {
          media_item_id: mediaItemId,
          season_number: 1,
          episode_number: 1,
        },
        update: {},
      });
      await prisma.episode.createMany({
        data: [{
          show_id: mediaItemId,
          episode_number: 1,
          title: "Película Completa",
        }],
        skipDuplicates: true,
      });
    }
    return 1;
  }

  const tvDetails = (details && "seasons" in details)
    ? details
    : await fetchDetails("series", tmdbId) as TmdbTvDetails | null;
  const episodesToCreate: Array<{ media_item_id: string; season_number: number; episode_number: number }> = [];
  for (const season of tvDetails?.seasons || []) {
    if (!season || season.season_number <= 0 || season.episode_count <= 0) continue;
    for (let episodeNumber = 1; episodeNumber <= season.episode_count; episodeNumber += 1) {
      episodesToCreate.push({
        media_item_id: mediaItemId,
        season_number: season.season_number,
        episode_number: episodeNumber,
      });
    }
  }

  if (!DRY_RUN && episodesToCreate.length > 0) {
    await prisma.mediaEpisode.createMany({
      data: episodesToCreate,
      skipDuplicates: true,
    });
    await prisma.episode.createMany({
      data: episodesToCreate.map((ep) => ({
        show_id: mediaItemId,
        episode_number: ep.episode_number,
        title: `Episodio ${ep.episode_number}`,
      })),
      skipDuplicates: true,
    });
  }
  return episodesToCreate.length;
}

async function upsertMedia(item: TmdbListItem, kind: MediaKind): Promise<{ created: boolean; episodes: number }> {
  const title = titleOf(item);
  const year = yearFrom(item.release_date || item.first_air_date);
  const normalized = normalizeTitle(title);
  const baseNormalized = normalizeBaseTitle(title) || normalized;

  const existing = await prisma.mediaItem.findFirst({
    where: {
      OR: [
        { tmdb_id: item.id, kind },
        { normalized_title: normalized, kind, year },
      ],
    },
    select: {
      id: true,
      description: true,
      rating: true,
      genres: true,
      original_title: true,
      poster_url: true,
      poster_path: true,
      backdrop_path: true,
      year: true,
    },
  });

  if (DRY_RUN) {
    return { created: !existing, episodes: 0 };
  }

  const details = await fetchDetails(kind, item.id);
  const detailTitle = kind === "movie"
    ? (details as TmdbMovieDetails | null)?.title
    : (details as TmdbTvDetails | null)?.name;
  const detailOriginalTitle = kind === "movie"
    ? (details as TmdbMovieDetails | null)?.original_title
    : (details as TmdbTvDetails | null)?.original_name;
  const localizedTitle = String(detailTitle || title).trim() || title;
  const originalTitle = String(detailOriginalTitle || originalTitleOf(item) || existing?.original_title || "").trim() || null;
  const normalizedLocalized = normalizeTitle(localizedTitle);
  const baseNormalizedLocalized = normalizeBaseTitle(localizedTitle) || normalizedLocalized;
  const detailYear = kind === "movie"
    ? yearFrom((details as TmdbMovieDetails | null)?.release_date)
    : yearFrom(item.first_air_date);
  const yearValue = detailYear || year || existing?.year || null;
  const description = String(details?.overview || item.overview || existing?.description || "").trim();
  const ratingValue = Number(details?.vote_average ?? item.vote_average ?? existing?.rating ?? 0);
  const genres = Array.isArray(details?.genres)
    ? details!.genres!.map((genre) => String(genre.name || "").trim()).filter(Boolean)
    : [];
  const genresValue = genres.join(", ") || String(existing?.genres || "").trim() || (
    kind === "anime" ? "Anime, Animación" : kind === "series" ? "Series" : "Película"
  );
  const posterPath = details?.poster_path || item.poster_path || existing?.poster_path || null;
  const backdropPath = details?.backdrop_path || item.backdrop_path || existing?.backdrop_path || null;
  const posterUrl = posterPath ? `${IMAGE_BASE}${posterPath}` : existing?.poster_url || null;
  const animeIdentity = kind === "anime"
    ? await fetchAnimeIdentity(localizedTitle, originalTitle)
    : { anilist_id: null, mal_id: null, kitsu_id: null };

  let normalizedForStorage = normalizedLocalized;
  const data = {
    title: localizedTitle,
    original_title: originalTitle,
    normalized_title: normalizedForStorage,
    base_normalized_title: baseNormalizedLocalized,
    description,
    rating: Number.isFinite(ratingValue) ? ratingValue : (existing?.rating || 0),
    genres: genresValue,
    tmdb_id: item.id,
    kind,
    year: yearValue,
    poster_path: posterPath,
    backdrop_path: backdropPath,
    poster_url: posterUrl,
  };

  let media;
  if (existing) {
    try {
      media = await prisma.mediaItem.update({ where: { id: existing.id }, data });
    } catch (error: any) {
      if (error?.code !== "P2002") throw error;
      // Two TMDB records can legitimately share the same localized title and
      // year. Keep the canonical base title for lookup but make the unique
      // normalized key deterministic per TMDB identity.
      normalizedForStorage = `${normalizedLocalized}-${item.id}`;
      data.normalized_title = normalizedForStorage;
      media = await prisma.mediaItem.update({ where: { id: existing.id }, data });
    }
  } else {
    try {
      media = await prisma.mediaItem.create({ data });
    } catch (e: any) {
      if (e?.code === "P2002") {
        normalizedForStorage = `${normalizedLocalized}-${item.id}`;
        data.normalized_title = normalizedForStorage;
        media = await prisma.mediaItem.create({ data });
      } else {
        throw e;
      }
    }
  }

  await prisma.show.upsert({
    where: { id: media.id },
    create: {
      id: media.id,
      title: data.title,
      original_title: data.original_title,
      normalized_title: data.normalized_title,
      base_normalized_title: data.base_normalized_title,
      tmdb_id: data.tmdb_id,
      category: kind,
      year: data.year || 2024,
      poster_url: data.poster_url,
      banner_url: data.backdrop_path ? `${BACKDROP_BASE}${data.backdrop_path}` : data.poster_url,
      poster_path: data.poster_path,
      backdrop_path: data.backdrop_path,
      description: data.description,
      rating: data.rating,
      genres: data.genres,
      mal_id: animeIdentity.mal_id,
      anilist_id: animeIdentity.anilist_id,
      kitsu_id: animeIdentity.kitsu_id,
      japanese_title: details?.original_language === "ja" ? data.original_title : null,
      english_title: details?.original_language === "en" ? data.original_title : null,
      status: details?.status || "Finalizado",
    },
    update: {
      title: data.title,
      original_title: data.original_title,
      normalized_title: data.normalized_title,
      base_normalized_title: data.base_normalized_title,
      tmdb_id: data.tmdb_id,
      category: kind,
      year: data.year || 2024,
      poster_url: data.poster_url,
      banner_url: data.backdrop_path ? `${BACKDROP_BASE}${data.backdrop_path}` : data.poster_url,
      poster_path: data.poster_path,
      backdrop_path: data.backdrop_path,
      description: data.description,
      rating: data.rating,
      genres: data.genres,
      mal_id: animeIdentity.mal_id ?? undefined,
      anilist_id: animeIdentity.anilist_id ?? undefined,
      kitsu_id: animeIdentity.kitsu_id ?? undefined,
      japanese_title: details?.original_language === "ja" ? data.original_title : undefined,
      english_title: details?.original_language === "en" ? data.original_title : undefined,
      status: details?.status || undefined,
    },
  });

  const episodes = await ensureEpisodeSkeleton(media.id, kind, item.id, details);
  return { created: !existing, episodes };
}

async function bootstrapGroup(label: string, items: TmdbListItem[], kind: MediaKind): Promise<{ created: number; updated: number; episodes: number }> {
  let created = 0;
  let updated = 0;
  let episodes = 0;

  console.log(`[bootstrap] ${label}: ${items.length} obras`);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const result = await upsertMedia(item, kind);
    if (result.created) created += 1;
    else updated += 1;
    episodes += result.episodes;

    if ((index + 1) % 25 === 0 || index + 1 === items.length) {
      console.log(`[bootstrap] ${label}: ${index + 1}/${items.length}`);
    }
  }

  return { created, updated, episodes };
}

async function maybeResetCanonicalCatalog(): Promise<void> {
  if (!RESET) return;
  const existingSources = await prisma.sourceLink.count();
  if (existingSources > 0) {
    throw new Error("--reset rechazado: existen SourceLink. Limpia/respáldalos explícitamente antes de destruir el catálogo canónico.");
  }
  if (DRY_RUN) return;
  await prisma.episode.deleteMany();
  await prisma.show.deleteMany();
  await prisma.mediaEpisode.deleteMany();
  await prisma.mediaItem.deleteMany();
  console.log("[bootstrap] catálogo canónico vacío preparado");
}

async function main(): Promise<void> {
  console.log("MeriStream bootstrap — catálogo canónico para BD vacía");
  console.log(`[bootstrap] movies=${MOVIE_TARGET} series=${SERIES_TARGET} anime=${ANIME_TARGET} dryRun=${DRY_RUN} reset=${RESET}`);

  await prisma.$queryRaw`SELECT 1`;
  await maybeResetCanonicalCatalog();

  const ratings = await seedProviderRatings();
  console.log(`[bootstrap] policies de provider preparadas: ${ratings}`);

  const [movies, tvRaw, anime] = await Promise.all([
    collect("/discover/movie", MOVIE_TARGET, {
      sort_by: "popularity.desc",
      include_adult: "false",
      "vote_count.gte": 100,
    }),
    collect("/discover/tv", Math.max(SERIES_TARGET * 2, SERIES_TARGET), {
      sort_by: "popularity.desc",
      include_adult: "false",
      "vote_count.gte": 50,
    }),
    collect("/discover/tv", ANIME_TARGET, {
      sort_by: "popularity.desc",
      include_adult: "false",
      with_original_language: "ja",
      with_genres: ANIMATION_GENRE_ID,
    }),
  ]);

  const animeIds = new Set(anime.map((item) => item.id));
  const series = tvRaw.filter((item) => !animeIds.has(item.id)).slice(0, SERIES_TARGET);

  const movieResult = await bootstrapGroup("movies", movies, "movie");
  const seriesResult = await bootstrapGroup("series", series, "series");
  const animeResult = await bootstrapGroup("anime", anime, "anime");

  const totalItems = await prisma.mediaItem.count();
  const totalEpisodes = await prisma.mediaEpisode.count();
  const totalSources = await prisma.sourceLink.count();

  console.log("\n[bootstrap] terminado");
  console.log(JSON.stringify({
    dryRun: DRY_RUN,
    providerPolicies: ratings,
    movies: movieResult,
    series: seriesResult,
    anime: animeResult,
    database: {
      mediaItems: totalItems,
      mediaEpisodes: totalEpisodes,
      sourceLinks: totalSources,
    },
    next: totalSources === 0
      ? "Arranca npm run dev y ejecuta ingestión/providers para poblar SourceLink; el catálogo TMDB ya está listo."
      : "El catálogo y las fuentes existentes fueron conservados; los providers pueden seguir actualizándolos.",
  }, null, 2));
}

main()
  .catch((error) => {
    console.error("[bootstrap] fallo:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
