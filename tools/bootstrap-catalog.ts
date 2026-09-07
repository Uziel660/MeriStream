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
};

type TmdbListResponse = {
  page: number;
  total_pages: number;
  results: TmdbListItem[];
};

type TmdbTvDetails = {
  id: number;
  seasons?: Array<{
    season_number: number;
    episode_count: number;
  }>;
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
  url.searchParams.set("language", "es-ES");
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

async function ensureEpisodeSkeleton(mediaItemId: string, kind: MediaKind, tmdbId: number): Promise<number> {
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

  const details = await tmdb<TmdbTvDetails>(`/tv/${tmdbId}`);
  const episodesToCreate: Array<{ media_item_id: string; season_number: number; episode_number: number }> = [];
  for (const season of details.seasons || []) {
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
    select: { id: true },
  });

  if (DRY_RUN) {
    return { created: !existing, episodes: 0 };
  }

  const data = {
    title,
    original_title: originalTitleOf(item),
    normalized_title: normalized,
    base_normalized_title: baseNormalized,
    tmdb_id: item.id,
    kind,
    year,
    poster_path: item.poster_path || null,
    backdrop_path: item.backdrop_path || null,
    poster_url: item.poster_path ? `${IMAGE_BASE}${item.poster_path}` : null,
  };

  let media;
  if (existing) {
    media = await prisma.mediaItem.update({ where: { id: existing.id }, data });
  } else {
    try {
      media = await prisma.mediaItem.create({ data });
    } catch (e: any) {
      if (e?.code === "P2002") {
        const found = await prisma.mediaItem.findFirst({
          where: { normalized_title: normalized, kind, year },
          select: { id: true },
        });
        if (found) {
          media = await prisma.mediaItem.update({ where: { id: found.id }, data });
        } else {
          throw e;
        }
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
      description: "",
      rating: 8.0,
      genres: kind === "anime" ? "Anime, Animación" : kind === "series" ? "Series" : "Película",
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
    },
  });

  const episodes = await ensureEpisodeSkeleton(media.id, kind, item.id);
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
