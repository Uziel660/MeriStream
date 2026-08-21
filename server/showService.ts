// server/showService.ts
import { prisma, normalizeTitle } from "./db";
import { enrichUniversalMetadata, cleanQueryTitle } from "./metadataEngine";
import { ContentKind } from "./types";

export interface SaveShowInput {
  mal_id?: number | null;
  anilist_id?: number | null;
  title: string;
  japanese_title?: string | null;
  english_title?: string | null;
  description?: string;
  poster_url?: string | null;
  banner_url?: string | null;
  content_type?: string;
  category?: string;
  rating?: number;
  year?: number;
  status?: string;
  genres?: string | string[];
  episodes?: Array<{
    number?: number;
    episode_number?: number;
    title?: string;
    url?: string;
    source_url?: string;
  }>;
  detected_streams?: string[];
}

function applyEnrichedMetadata(target: any, enriched: any) {
  if (!enriched) return;
  if (enriched.mal_id) target.malId = enriched.mal_id;
  if (enriched.anilist_id) target.anilistId = enriched.anilist_id;
  if (enriched.title) target.title = enriched.title;
  if (enriched.japanese_title) target.japaneseTitle = enriched.japanese_title;
  if (enriched.english_title) target.englishTitle = enriched.english_title;
  if (enriched.description && enriched.description.length > 20) target.description = enriched.description;
  if (enriched.poster_url) target.posterUrl = enriched.poster_url;
  if (enriched.banner_url) target.bannerUrl = enriched.banner_url || enriched.poster_url;
  if (enriched.rating) target.rating = enriched.rating;
  if (enriched.year) target.year = enriched.year;
  if (enriched.status) target.status = enriched.status;
  if (enriched.genres && enriched.genres.length > 0) target.genresStr = enriched.genres.join(", ");
}

function buildNormalizedEpisodes(input: SaveShowInput, kind: ContentKind) {
  const inputEpisodes = input.episodes || [];
  const normalizedEpisodes = inputEpisodes.map((ep, idx) => ({
    number: ep.number ?? ep.episode_number ?? idx + 1,
    title: ep.title || `Episodio ${ep.number ?? ep.episode_number ?? idx + 1}`,
    url: ep.url || ep.source_url || input.detected_streams?.[0] || "",
  }));

  if (normalizedEpisodes.length === 0 && input.detected_streams && input.detected_streams.length > 0) {
    normalizedEpisodes.push({
      number: 1,
      title: kind === "movie" ? "Película Completa" : "Episodio 1",
      url: input.detected_streams[0],
    });
  }

  return normalizedEpisodes;
}

async function findExistingShow(malId: number | null, normTitle: string, normEng: string, normJap: string) {
  if (malId && malId > 0) {
    const byMal = await prisma.show.findUnique({
      where: { mal_id: malId },
      include: { episodes: true },
    });
    if (byMal) return byMal;
  }

  if (!normTitle) return null;

  const candidates = await prisma.show.findMany({
    take: 20,
    include: { episodes: true },
  });

  return candidates.find((s) => {
    const dbNormTitle = normalizeTitle(s.title);
    const dbNormJap = s.japanese_title ? normalizeTitle(s.japanese_title) : "";
    const dbNormEng = s.english_title ? normalizeTitle(s.english_title) : "";

    return (
      (dbNormTitle && dbNormTitle === normTitle) ||
      (dbNormEng && dbNormEng === normTitle) ||
      (dbNormJap && dbNormJap === normTitle) ||
      (normEng && dbNormEng && dbNormEng === normEng) ||
      (normEng && dbNormTitle && dbNormTitle === normEng) ||
      (normJap && dbNormJap && dbNormJap === normJap)
    );
  }) || null;
}

async function mergeShowEpisodes(existingShow: any, showData: any, normalizedEpisodes: Array<{ number: number; title: string; url: string }>) {
  console.log(`[Deduplication] Obra existente detectada: '${existingShow.title}' (ID: ${existingShow.id}). Fusionando datos...`);

  const updatePayload: any = {};
  if (!existingShow.mal_id && showData.malId) updatePayload.mal_id = showData.malId;
  if (!existingShow.anilist_id && showData.anilistId) updatePayload.anilist_id = showData.anilistId;
  if (!existingShow.japanese_title && showData.japaneseTitle) updatePayload.japanese_title = showData.japaneseTitle;
  if (!existingShow.english_title && showData.englishTitle) updatePayload.english_title = showData.englishTitle;
  if ((!existingShow.poster_url || existingShow.poster_url === "") && showData.posterUrl) updatePayload.poster_url = showData.posterUrl;
  if ((!existingShow.banner_url || existingShow.banner_url === "") && showData.bannerUrl) updatePayload.banner_url = showData.bannerUrl;

  if (Object.keys(updatePayload).length > 0) {
    await prisma.show.update({
      where: { id: existingShow.id },
      data: updatePayload,
    });
  }

  let addedCount = 0;
  for (const ep of normalizedEpisodes) {
    const alreadyHas = existingShow.episodes.some(
      (existingEp: any) => existingEp.episode_number === ep.number || (ep.url && existingEp.source_url === ep.url)
    );

    if (!alreadyHas) {
      await prisma.episode.create({
        data: {
          show_id: existingShow.id,
          episode_number: ep.number,
          title: ep.title,
          source_url: ep.url,
        },
      });
      addedCount++;
    }
  }

  const updatedShow = await prisma.show.findUnique({
    where: { id: existingShow.id },
    include: {
      episodes: {
        orderBy: { episode_number: "asc" },
      },
    },
  });

  return {
    show: updatedShow!,
    isDuplicate: true,
    episodesAdded: addedCount,
  };
}

/**
 * Ensures show passes through AniList / MAL metadata enrichment first,
 * then performs anti-duplication lookup by mal_id and normalized titles,
 * and saves or merges into PostgreSQL.
 */
export async function saveShowWithDeduplication(input: SaveShowInput) {
  const rawTitle = cleanQueryTitle(input.title);
  const kind: ContentKind = (input.content_type || input.category || "anime") as ContentKind;

  const showData = {
    malId: input.mal_id || null,
    anilistId: input.anilist_id || null,
    title: input.title,
    japaneseTitle: input.japanese_title || null,
    englishTitle: input.english_title || null,
    description: input.description || "",
    posterUrl: input.poster_url || null,
    bannerUrl: input.banner_url || null,
    rating: input.rating || 8.0,
    year: input.year || new Date().getFullYear(),
    status: input.status || "Finalizado",
    genresStr: Array.isArray(input.genres) ? input.genres.join(", ") : (input.genres || "Multimedia")
  };

  try {
    const enriched = await enrichUniversalMetadata(rawTitle, kind);
    applyEnrichedMetadata(showData, enriched);
  } catch (e) {
    console.error("Enrichment warning during deduplication:", e);
  }

  const normTitle = normalizeTitle(showData.title);
  const normJap = showData.japaneseTitle ? normalizeTitle(showData.japaneseTitle) : "";
  const normEng = showData.englishTitle ? normalizeTitle(showData.englishTitle) : "";

  const existingShow = await findExistingShow(showData.malId, normTitle, normEng, normJap);
  const normalizedEpisodes = buildNormalizedEpisodes(input, kind);

  if (existingShow) {
    return await mergeShowEpisodes(existingShow, showData, normalizedEpisodes);
  }

  console.log(`[Deduplication] Nueva obra verificada sin duplicados. Guardando en PostgreSQL...`);

  const createdShow = await prisma.show.create({
    data: {
      mal_id: showData.malId,
      anilist_id: showData.anilistId,
      title: showData.title,
      japanese_title: showData.japaneseTitle,
      english_title: showData.englishTitle,
      normalized_title: normTitle,
      description: showData.description || "Obra multimedia indexada.",
      poster_url: showData.posterUrl,
      banner_url: showData.bannerUrl || showData.posterUrl,
      category: kind,
      rating: showData.rating,
      year: showData.year,
      status: showData.status,
      genres: showData.genresStr,
      episodes: {
        create: normalizedEpisodes.map((ep) => ({
          episode_number: ep.number,
          title: ep.title,
          source_url: ep.url,
        })),
      },
    },
    include: {
      episodes: {
        orderBy: { episode_number: "asc" },
      },
    },
  });

  return {
    show: createdShow,
    isDuplicate: false,
    episodesAdded: normalizedEpisodes.length,
  };
}

/**
 * Returns all shows from PostgreSQL with optional search/category filter
 */
export async function getShowsFromDb(search?: string, category?: string) {
  let where: any = {};

  if (category) {
    where.category = { contains: category, mode: "insensitive" };
  }

  if (search) {
    const s = search.toLowerCase().trim();
    where.OR = [
      { title: { contains: s, mode: "insensitive" } },
      { english_title: { contains: s, mode: "insensitive" } },
      { japanese_title: { contains: s, mode: "insensitive" } },
      { genres: { contains: s, mode: "insensitive" } },
    ];
  }

  const shows = await prisma.show.findMany({
    where,
    include: {
      episodes: {
        orderBy: { episode_number: "asc" },
      },
    },
    orderBy: { created_at: "desc" },
  });

  return shows;
}

/**
 * Get single show by ID
 */
export async function getShowByIdFromDb(id: string) {
  return prisma.show.findUnique({
    where: { id },
    include: {
      episodes: {
        orderBy: { episode_number: "asc" },
      },
    },
  });
}

/**
 * Delete single show by ID
 */
export async function deleteShowFromDb(id: string) {
  return prisma.show.delete({
    where: { id },
  });
}

/**
 * Clear all shows from database
 */
export async function clearAllShowsFromDb() {
  await prisma.episode.deleteMany({});
  await prisma.show.deleteMany({});
}
