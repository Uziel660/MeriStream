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

/**
 * Ensures show passes through AniList / MAL metadata enrichment first,
 * then performs anti-duplication lookup by mal_id and normalized titles,
 * and saves or merges into PostgreSQL.
 */
export async function saveShowWithDeduplication(input: SaveShowInput) {
  let rawTitle = cleanQueryTitle(input.title);
  let kind: ContentKind = (input.content_type || input.category || "anime") as ContentKind;

  // 1. Mandatory Enrichment via AniList / Jikan MAL if metadata is incomplete or missing mal_id
  let malId = input.mal_id || null;
  let anilistId = input.anilist_id || null;
  let title = input.title;
  let japaneseTitle = input.japanese_title || null;
  let englishTitle = input.english_title || null;
  let description = input.description || "";
  let posterUrl = input.poster_url || null;
  let bannerUrl = input.banner_url || null;
  let rating = input.rating || 8.0;
  let year = input.year || new Date().getFullYear();
  let status = input.status || "Finalizado";
  let genresStr = Array.isArray(input.genres) ? input.genres.join(", ") : (input.genres || "Multimedia");

  try {
    const enriched = await enrichUniversalMetadata(rawTitle, kind);
    if (enriched) {
      if (enriched.mal_id) malId = enriched.mal_id;
      if (enriched.anilist_id) anilistId = enriched.anilist_id;
      if (enriched.title) title = enriched.title;
      if (enriched.japanese_title) japaneseTitle = enriched.japanese_title;
      if (enriched.english_title) englishTitle = enriched.english_title;
      if (enriched.description && enriched.description.length > 20) description = enriched.description;
      if (enriched.poster_url) posterUrl = enriched.poster_url;
      if (enriched.banner_url) bannerUrl = enriched.banner_url || enriched.poster_url;
      if (enriched.rating) rating = enriched.rating;
      if (enriched.year) year = enriched.year;
      if (enriched.status) status = enriched.status;
      if (enriched.genres && enriched.genres.length > 0) genresStr = enriched.genres.join(", ");
    }
  } catch (e) {
    console.error("Enrichment warning during deduplication:", e);
  }

  const normTitle = normalizeTitle(title);
  const normJap = japaneseTitle ? normalizeTitle(japaneseTitle) : "";
  const normEng = englishTitle ? normalizeTitle(englishTitle) : "";

  // 2. Search DB for duplicate show
  let existingShow = null;

  // Check A: Match by MAL ID
  if (malId && malId > 0) {
    existingShow = await prisma.show.findUnique({
      where: { mal_id: malId },
      include: { episodes: true },
    });
  }

  // Check B: Match by Normalized Title or English/Japanese titles
  if (!existingShow && normTitle) {
    const candidates = await prisma.show.findMany({
      take: 20,
      include: { episodes: true },
    });

    existingShow = candidates.find((s) => {
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
    });
  }

  // Build normalized episodes list
  const inputEpisodes = input.episodes || [];
  const normalizedEpisodes = inputEpisodes.map((ep, idx) => ({
    number: ep.number ?? ep.episode_number ?? idx + 1,
    title: ep.title || `Episodio ${ep.number ?? ep.episode_number ?? idx + 1}`,
    url: ep.url || ep.source_url || (input.detected_streams && input.detected_streams[0]) || "",
  }));

  if (normalizedEpisodes.length === 0 && input.detected_streams && input.detected_streams.length > 0) {
    normalizedEpisodes.push({
      number: 1,
      title: kind === "movie" ? "Película Completa" : "Episodio 1",
      url: input.detected_streams[0],
    });
  }

  // 3. If show exists: MERGE new episodes into existing show
  if (existingShow) {
    console.log(`[Deduplication] Obra existente detectada: '${existingShow.title}' (ID: ${existingShow.id}). Fusionando datos...`);

    // Update missing fields if new data has better info
    const updatePayload: any = {};
    if (!existingShow.mal_id && malId) updatePayload.mal_id = malId;
    if (!existingShow.anilist_id && anilistId) updatePayload.anilist_id = anilistId;
    if (!existingShow.japanese_title && japaneseTitle) updatePayload.japanese_title = japaneseTitle;
    if (!existingShow.english_title && englishTitle) updatePayload.english_title = englishTitle;
    if ((!existingShow.poster_url || existingShow.poster_url === "") && posterUrl) updatePayload.poster_url = posterUrl;
    if ((!existingShow.banner_url || existingShow.banner_url === "") && bannerUrl) updatePayload.banner_url = bannerUrl;

    if (Object.keys(updatePayload).length > 0) {
      await prisma.show.update({
        where: { id: existingShow.id },
        data: updatePayload,
      });
    }

    // Merge episodes
    let addedCount = 0;
    for (const ep of normalizedEpisodes) {
      const alreadyHas = existingShow.episodes.some(
        (existingEp) => existingEp.episode_number === ep.number || (ep.url && existingEp.source_url === ep.url)
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

    // Return refreshed show with all episodes
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

  // 4. If show is NEW: Create in DB
  console.log(`[Deduplication] Nueva obra verificada sin duplicados: '${title}'. Guardando en PostgreSQL...`);

  const createdShow = await prisma.show.create({
    data: {
      mal_id: malId,
      anilist_id: anilistId,
      title: title,
      japanese_title: japaneseTitle,
      english_title: englishTitle,
      normalized_title: normTitle,
      description: description || "Obra multimedia indexada.",
      poster_url: posterUrl,
      banner_url: bannerUrl || posterUrl,
      category: kind,
      rating: rating,
      year: year,
      status: status,
      genres: genresStr,
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
