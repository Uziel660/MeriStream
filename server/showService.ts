// server/showService.ts
import { prisma, normalizeTitle } from "./db";
import { enqueueShowBackfill, showNeedsBackfill } from "./metadataBackfill";
import { enrichUniversalMetadata, cleanQueryTitle, parseTitleQuery } from "./metadataEngine";
import { applyEnrichmentGapFill, hasSubstantiveText, isPlausibleYear } from "./metadataMerge";
import { ContentKind, SourceLinkInput, SourceKind } from "./types";
import { classifySourceKind } from "./resolutionMetadata";
import { getStreamTier } from "./utils/streamSorter";
import { normalizeTitleKey, parseRawTitle, isPlausibleTitle, isSlugLikeTitle, cleanSlugToWords } from "./utils/titleNormalizer";
import { formatAndNormalizeGenres } from "./utils/genreNormalizer";
import { extractStreamFromUrl } from "./universalScraper";
import { canonicalCatalogUrl } from "./catalogIntegrity";
import {
  enqueueWrite,
  enqueueShowCreate,
  enqueueShowUpdate,
  enqueueMediaItemCreate,
  enqueueMediaItemUpdate,
  enqueueEpisodeCreateMany,
  enqueueSourceLinkUpdate,
} from "./writeBuffer";

export type { SourceLinkInput };

// La importación masiva puede procesar decenas de miles de entradas. Escribir
// una línea de consola por cada deduplicación consume más I/O que la operación
// de base de datos y atasca la terminal; se deja opt-in para diagnóstico local.
const VERBOSE_DEDUP_LOGS = process.env.MERISTREAM_VERBOSE_DEDUP === "1";
const dedupLog = (...args: unknown[]): void => {
  if (VERBOSE_DEDUP_LOGS) console.log(...args);
};

function sourceIdentityKey(url: string): string {
  const kind = classifySourceKind(url);
  return kind === "page" || kind === "embed" ? canonicalCatalogUrl(url) : url.trim();
}

/** Para TMDB, anime y series son ambos TV; solo se separan de películas. */
function tmdbCategoryFilter(kind: ContentKind): { category: string | { in: string[] } } {
  return kind === "anime" || kind === "series"
    ? { category: { in: ["anime", "series"] } }
    : { category: kind };
}

function tmdbKindFilter(kind: ContentKind): { kind: string | { in: string[] } } {
  return kind === "anime" || kind === "series"
    ? { kind: { in: ["anime", "series"] } }
    : { kind };
}

export interface SaveShowInput {
  mal_id?: number | null;
  anilist_id?: number | null;
  tmdb_id?: number | null;
  /** Temporada detectada en el título ("TP2", "Temporada 2"). Default: 1. */
  season?: number | null;
  title: string;
  original_title?: string | null;
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
  /** Sitio de origen del crawl; se propaga a los SourceLink sin source_site propio. */
  source_site?: string;
  /** Plataforma de origen (animeflv, lamovie, cinecalidad, etc.). Se guarda en Show.source. */
  source?: string;
  /** Fuentes adicionales de la obra; se adjuntan al primer episodio (caso película). */
  sources?: SourceLinkInput[];
  episodes?: Array<{
    number?: number;
    episode_number?: number;
    title?: string;
    url?: string;
    source_url?: string;
    /** Fuentes específicas de este episodio (multi-origen). */
    sources?: SourceLinkInput[];
  }>;
  detected_streams?: string[];
}

/**
 * Defectos #10/#13/#16: el enriquecimiento externo ya NO sobrescribe los metadatos
 * que el scraper trajo de la ficha real. La fusión es scraper-first: solo llena
 * huecos y descarta placeholders ("Contenido indexado en VoidStream...", poster
 * Unsplash, año corriente). Ver server/metadataMerge.ts.
 */
function applyEnrichedMetadata(
  input: SaveShowInput,
  target: {
    malId: number | null;
    anilistId: number | null;
    title: string;
    japaneseTitle: string | null;
    englishTitle: string | null;
    description: string;
    posterUrl: string | null;
    bannerUrl: string | null;
    rating: number;
    year: number;
    status: string;
    genresStr: string;
  },
  enriched: any
) {
  applyEnrichmentGapFill(
    {
      title: input.title,
      description: input.description,
      poster_url: input.poster_url,
      banner_url: input.banner_url,
      rating: input.rating,
      year: input.year,
      status: input.status,
      genres: input.genres,
    },
    target,
    enriched
  );
}

export function buildNormalizedEpisodes(input: SaveShowInput, kind: ContentKind) {
  const inputEpisodes = input.episodes || [];
  const defaultSite = input.source_site || "unknown";
  const detectedStreams: string[] = Array.isArray(input.detected_streams)
    ? input.detected_streams.filter((s): s is string => typeof s === "string" && Boolean(s.trim()))
    : [];

  const isMovie =
    kind === "movie" ||
    input.content_type === "movie" ||
    input.category === "movie";

  if (isMovie) {
    const rawEp = inputEpisodes[0] || null;
    const primaryUrl =
      rawEp?.url ||
      rawEp?.source_url ||
      detectedStreams[0] ||
      (input as any).source_url ||
      (input as any).url ||
      "";
    const streamSources: SourceLinkInput[] = [];
    const seenUrls = new Set<string>();

    // 1. URL primaria
    if (primaryUrl) {
      const kind = classifySourceKind(primaryUrl);
      if (kind !== "ephemeral_direct") {
        streamSources.push({ url: primaryUrl, source_site: defaultSite, source_kind: kind });
        seenUrls.add(sourceIdentityKey(primaryUrl));
      }
    }
    // 2. detected_streams
    for (const st of detectedStreams) {
      if (st && !seenUrls.has(sourceIdentityKey(st))) {
        const kind = classifySourceKind(st);
        if (kind !== "ephemeral_direct") {
          streamSources.push({ url: st, source_site: defaultSite, source_kind: kind });
          seenUrls.add(sourceIdentityKey(st));
        }
      }
    }
    // 3. rawEp sources
    if (rawEp?.sources) {
      for (const s of rawEp.sources) {
        if (s?.url && !seenUrls.has(sourceIdentityKey(s.url))) {
          const kind = classifySourceKind(s.url);
          if (kind !== "ephemeral_direct") {
            streamSources.push({ ...s, source_site: s.source_site || defaultSite, source_kind: kind });
            seenUrls.add(sourceIdentityKey(s.url));
          }
        }
      }
    }
    // 4. input.sources
    if (input.sources) {
      for (const s of input.sources) {
        if (s?.url && !seenUrls.has(sourceIdentityKey(s.url))) {
          const kind = classifySourceKind(s.url);
          if (kind !== "ephemeral_direct") {
            streamSources.push({ ...s, source_site: s.source_site || defaultSite, source_kind: kind });
            seenUrls.add(sourceIdentityKey(s.url));
          }
        }
      }
    }

    if (streamSources.length > 0) {
      return [
        {
          number: 1,
          title: rawEp?.title || "Película Completa",
          url: streamSources[0].url,
          sources: streamSources,
        },
      ];
    }
  }

  // Series / anime:
  const normalizedEpisodes = inputEpisodes
    .filter((ep) => Boolean(ep.url || ep.source_url || (ep.sources && ep.sources.length > 0)))
    .map((ep, idx) => {
      const epNum = ep.number ?? ep.episode_number ?? idx + 1;
      const primaryUrl = ep.url || ep.source_url || (ep.sources && ep.sources[0]?.url) || "";
      const epSources: SourceLinkInput[] = [];
      const seen = new Set<string>();

      if (primaryUrl) {
        const kind = classifySourceKind(primaryUrl);
        if (kind !== "ephemeral_direct") {
          epSources.push({ url: primaryUrl, source_site: defaultSite, source_kind: kind });
          seen.add(sourceIdentityKey(primaryUrl));
        }
      }

      if (ep.sources) {
        for (const s of ep.sources) {
          if (s?.url && !seen.has(sourceIdentityKey(s.url))) {
            const kind = classifySourceKind(s.url);
            if (kind !== "ephemeral_direct") {
              epSources.push({ ...s, source_site: s.source_site || defaultSite, source_kind: kind });
              seen.add(sourceIdentityKey(s.url));
            }
          }
        }
      }

      return {
        number: epNum,
        title: ep.title || (kind === "movie" ? "Película Completa" : `Episodio ${epNum}`),
        url: epSources[0]?.url || "",
        sources: epSources,
      };
    })
    .filter((episode) => Boolean(episode.url));

  if (normalizedEpisodes.length === 0) {
    const fallbackUrl = detectedStreams[0] || (input as any).source_url || (input as any).url || "";
    if (fallbackUrl) {
      const fallbackKind = classifySourceKind(fallbackUrl);
      const fallbackSources = detectedStreams
        .filter((st) => classifySourceKind(st) !== "ephemeral_direct")
        .map((st) => ({ url: st, source_site: defaultSite, source_kind: classifySourceKind(st) }));
      const persistentFallbacks = fallbackSources.length > 0
        ? fallbackSources
        : fallbackKind !== "ephemeral_direct"
          ? [{ url: fallbackUrl, source_site: defaultSite, source_kind: fallbackKind }]
          : [];
      if (persistentFallbacks.length > 0) {
        normalizedEpisodes.push({
          number: 1,
          title: kind === "movie" ? "Película Completa" : "Episodio 1",
          url: persistentFallbacks[0].url,
          sources: persistentFallbacks,
        });
      }
    }
  }

  return normalizedEpisodes;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Arquitectura multi-fuente: aglutina N SourceLink bajo un único MediaEpisode deduplicado.
 */
export async function syncEpisodeSources(
  mediaItemId: string,
  season: number,
  episodeNumber: number,
  sources: SourceLinkInput[],
  defaultSite: string
): Promise<number> {
  const cleanSources = (sources || []).filter((s) => s && s.url && typeof s.url === "string" && s.url.trim());
  if (cleanSources.length === 0) return 0;

  const persistentSources = cleanSources.filter((s) => {
    const kind = classifySourceKind(s.url);
    return kind !== "ephemeral_direct";
  });
  if (persistentSources.length === 0) return 0;

  let sourcesAdded = 0;

  enqueueWrite({
    kind: "mediaEpisode.upsert",
    where: {
      media_item_id_season_number_episode_number: {
        media_item_id: mediaItemId,
        season_number: season,
        episode_number: episodeNumber,
      },
    },
    create: { media_item_id: mediaItemId, season_number: season, episode_number: episodeNumber },
  });

  for (const src of persistentSources) {
    const rawUrl = src.url.trim();
    const kind = classifySourceKind(rawUrl);
    const linkType = src.link_type || (kind === "embed" ? "embed" : kind === "page" ? "page" : "direct");
    const site = src.source_site || defaultSite || "unknown";

    const existing = await prisma.sourceLink.findFirst({
      where: {
        url: rawUrl,
        source_site: site,
        media_episode: {
          media_item_id: mediaItemId,
          season_number: season,
          episode_number: episodeNumber,
        },
      },
      select: {
        id: true,
        language: true,
        audio_language: true,
        subtitle_language: true,
        subtitles: true,
        canonical_locator: true,
        host: true,
        extraction_method: true,
        resolver_version: true,
      },
    });

    if (!existing) {
      const queued = enqueueWrite({
        kind: "sourceLink.create",
        episodeRef: {
          media_item_id: mediaItemId,
          season_number: season,
          episode_number: episodeNumber,
        },
        data: {
          source_site: site,
          url: rawUrl,
          link_type: linkType,
          language: src.language ?? null,
          audio_language: src.audio_language ?? null,
          subtitle_language: src.subtitle_language ?? null,
          subtitles: src.subtitles ?? undefined,
          host: src.host ?? hostOf(rawUrl),
          priority_tier: getStreamTier(rawUrl),
          // La importación solo demuestra que el enlace fue descubierto. La
          // resolución JIT/revisión del reproductor hará avanzar la evidencia.
          source_status: "discovered",
          canonical_locator: kind === "page" || kind === "embed" ? rawUrl : null,
          extraction_method: "catalog_import",
          resolver_version: "catalog-v2",
          // Importar una URL no demuestra que nuestro reproductor la haya
          // decodificado; la verificación se concede en la fase de media/UI.
          is_verified: false,
          last_checked: new Date().toISOString(),
        },
      });
      if (queued) sourcesAdded++;
    } else {
      // Una reimportación puede descubrir idioma, subtítulos o un localizador
      // canónico que no existían en la primera pasada. Actualizar solo esos
      // huecos conserva el estado de salud/verified y evita duplicar enlaces.
      const evidence: Record<string, unknown> = {};
      if (src.language && existing.language !== src.language) evidence.language = src.language;
      if (src.audio_language && existing.audio_language !== src.audio_language) evidence.audio_language = src.audio_language;
      if (src.subtitle_language && existing.subtitle_language !== src.subtitle_language) evidence.subtitle_language = src.subtitle_language;
      if (src.subtitles !== undefined && existing.subtitles == null) evidence.subtitles = src.subtitles;
      if (!existing.canonical_locator && (kind === "page" || kind === "embed")) evidence.canonical_locator = rawUrl;
      if (!existing.host) evidence.host = src.host ?? hostOf(rawUrl);
      if (!existing.extraction_method) evidence.extraction_method = "catalog_import";
      if (!existing.resolver_version) evidence.resolver_version = "catalog-v2";
      if (Object.keys(evidence).length > 0) enqueueSourceLinkUpdate(existing.id, evidence);
    }
  }
  return sourcesAdded;
}

function pickYearCompatible<T extends { year: number | null }>(candidates: T[], year: number | null): T | null {
  if (candidates.length === 0) return null;
  if (year === null || !isPlausibleYear(year)) return candidates[0];
  const exact = candidates.filter((c) => c.year === year);
  if (exact.length > 0) return exact[0];
  const unknownish = candidates.filter((c) => !isPlausibleYear(c.year ?? null));
  return unknownish[0] ?? null;
}

async function findExistingShowByBase(baseNorm: string, year: number | null, category?: ContentKind) {
  if (!baseNorm) return null;
  const candidates = await prisma.show.findMany({
    // El título normalizado es un fallback; nunca debe cruzar una película
    // con un anime/serie homónimo. La identidad TMDB se resuelve antes y
    // puede unir aliases reales, pero el fallback local conserva la categoría.
    where: { base_normalized_title: baseNorm, ...(category ? { category } : {}) },
    include: { episodes: true },
    orderBy: { created_at: "asc" },
  });
  return pickYearCompatible(candidates, year);
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
    where: { normalized_title: { in: [normTitle, normEng, normJap].filter(Boolean) } },
    take: 50,
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
  dedupLog(`[Deduplication] Obra existente detectada: '${existingShow.title}' (ID: ${existingShow.id}). Fusionando datos...`);

  const updatePayload: any = {};
  const existingTitleStr = String(existingShow.title ?? "").trim();
  const incomingTitleStr = String(showData.title ?? "").trim();
  const incomingIsClean = parseRawTitle(incomingTitleStr).canonical === incomingTitleStr;

  // Reparar slug si la obra existente tenía un slug pegado ("sixjoursceprintempsla")
  if (isSlugLikeTitle(existingTitleStr) && !isSlugLikeTitle(incomingTitleStr)) {
    dedupLog(`[Deduplication] Título reparado de slug: '${existingTitleStr}' → '${incomingTitleStr}'`);
    updatePayload.title = incomingTitleStr;
    updatePayload.normalized_title = normalizeTitleKey(incomingTitleStr) || normalizeTitle(incomingTitleStr);
    updatePayload.base_normalized_title = normalizeTitleKey(incomingTitleStr);
  } else if (
    incomingTitleStr &&
    incomingIsClean &&
    parseRawTitle(existingTitleStr).canonical !== existingTitleStr &&
    normalizeTitleKey(existingTitleStr) === normalizeTitleKey(incomingTitleStr)
  ) {
    dedupLog(`[Deduplication] Título normalizado: '${existingTitleStr}' → '${incomingTitleStr}'`);
    updatePayload.title = incomingTitleStr;
    updatePayload.normalized_title = normalizeTitleKey(incomingTitleStr) || normalizeTitle(incomingTitleStr);
  }

  if (!existingShow.mal_id && showData.malId) updatePayload.mal_id = showData.malId;
  if (!existingShow.anilist_id && showData.anilistId) updatePayload.anilist_id = showData.anilistId;
  if (!existingShow.tmdb_id && showData.tmdbId) updatePayload.tmdb_id = showData.tmdbId;
  if (!existingShow.original_title && showData.originalTitle) updatePayload.original_title = showData.originalTitle;
  if (!existingShow.japanese_title && showData.japaneseTitle) updatePayload.japanese_title = showData.japaneseTitle;
  if (!existingShow.english_title && showData.englishTitle) updatePayload.english_title = showData.englishTitle;
  if (!hasSubstantiveText(existingShow.description) && hasSubstantiveText(showData.description)) {
    updatePayload.description = showData.description;
  }
  if (
    isPlausibleYear(showData.year) &&
    (!isPlausibleYear(existingShow.year) ||
      (showData.tmdbId && (!existingShow.tmdb_id || existingShow.tmdb_id === showData.tmdbId) && existingShow.year !== showData.year))
  ) {
    updatePayload.year = showData.year;
  }
  if ((!existingShow.poster_url || existingShow.poster_url === "") && showData.posterUrl) updatePayload.poster_url = showData.posterUrl;
  if ((!existingShow.banner_url || existingShow.banner_url === "") && showData.bannerUrl) updatePayload.banner_url = showData.bannerUrl;

  // Actualizar géneros si estaban incompletos o sin formato
  if (
    showData.genresStr &&
    showData.genresStr !== "Multimedia" &&
    (!existingShow.genres || existingShow.genres === "Multimedia" || !existingShow.genres.includes(","))
  ) {
    updatePayload.genres = showData.genresStr;
  }

  if (Object.keys(updatePayload).length > 0) {
    enqueueShowUpdate(existingShow.id, updatePayload);
  }

  // BATCH: una sola ida a la BD para todos los episodios nuevos.
  const missingEps = normalizedEpisodes.filter(
    (ep) =>
      !existingShow.episodes.some(
        (existingEp: any) => existingEp.episode_number === ep.number || (ep.url && existingEp.source_url === ep.url)
      )
  );
  const addedCount = missingEps.length;
  if (missingEps.length > 0) {
    await prisma.episode.createMany({
      data: missingEps.map((ep) => ({
        show_id: existingShow.id,
        episode_number: ep.number,
        title: ep.title,
        source_url: ep.url,
      })),
    });
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

/** Info canónica calculada por saveShowWithDeduplication y reutilizada aquí. */
interface CanonicalTitleInfo {
  canonical: string;
  norm: string;
  baseNorm: string;
  year: number | null;
}

/**
 * Espeja la obra guardada (legacy Show) hacia la arquitectura multi-fuente.
 */
async function syncMediaItemSources(
  input: SaveShowInput,
  kind: ContentKind,
  legacyShowId: string,
  normalizedEpisodes: Array<{ number: number; title: string; url: string; sources: SourceLinkInput[] }>,
  titleInfo: CanonicalTitleInfo
) {
  try {
    const canonical = titleInfo.canonical || input.title;
    const norm = titleInfo.norm || normalizeTitle(canonical);
    if (!norm) return 0;

    const baseNorm = titleInfo.baseNorm || norm;
    const season = input.season ?? parseTitleQuery(canonical).season ?? 1;
    const enrichedAny = (input as any)._enriched || null;
    const year =
      titleInfo.year !== null && isPlausibleYear(titleInfo.year)
        ? titleInfo.year
        : input.year && isPlausibleYear(input.year)
          ? input.year
          : null;

    // El Show legacy puede tener ya un TMDB ID aunque esta pasada llegue sin
    // metadata enriquecida (por ejemplo, durante un reescaneo ligero). Usarlo
    // aquí evita crear MediaItems paralelos sin identidad TMDB y permite que
    // todas las fuentes de una misma obra converjan en la misma temporada.
    let legacyTmdbId = input.tmdb_id ?? enrichedAny?.tmdb_id ?? null;
    if (!legacyTmdbId && legacyShowId) {
      const legacy = await prisma.show.findUnique({
        where: { id: legacyShowId },
        select: { tmdb_id: true },
      });
      legacyTmdbId = legacy?.tmdb_id ?? null;
    }
    const tmdbId = legacyTmdbId;
    const orConditions = [
      { base_normalized_title: baseNorm, kind },
      ...(baseNorm !== norm ? [{ normalized_title: norm, kind }] : []),
    ];
    const itemCandidates = await prisma.mediaItem.findMany({
      where: { OR: orConditions },
      orderBy: { created_at: "asc" },
    });
    let mediaItem = tmdbId
      ? await prisma.mediaItem.findFirst({
          where: { tmdb_id: tmdbId, ...tmdbKindFilter(kind) },
          orderBy: { created_at: "asc" },
        })
      : null;
    if (!mediaItem) mediaItem = pickYearCompatible(itemCandidates, year);
    if (!mediaItem) {
      const itemId = enqueueMediaItemCreate({
        normalized_title: norm,
        base_normalized_title: baseNorm,
        title: canonical,
        kind,
        year,
        tmdb_id: tmdbId,
        original_title: (enrichedAny?.original_title as string | undefined) || null,
        poster_url: input.poster_url || null,
        poster_path: enrichedAny?.poster_path || null,
        backdrop_path: enrichedAny?.backdrop_path || null,
      });
      mediaItem = { id: itemId, normalized_title: norm, base_normalized_title: baseNorm, title: canonical, kind, year } as any;
    } else {
      const updateData: Record<string, unknown> = {};
      if (!mediaItem.base_normalized_title) updateData.base_normalized_title = baseNorm;
      if (input.poster_url && !mediaItem.poster_url) updateData.poster_url = input.poster_url;
      if (tmdbId && !mediaItem.tmdb_id) updateData.tmdb_id = tmdbId;
      if (enrichedAny?.poster_path && !mediaItem.poster_path) updateData.poster_path = enrichedAny.poster_path;
      if (enrichedAny?.backdrop_path && !mediaItem.backdrop_path) updateData.backdrop_path = enrichedAny.backdrop_path;
      if (Object.keys(updateData).length > 0) {
        enqueueMediaItemUpdate(mediaItem.id, updateData);
      }
    }

    const defaultSite = input.source_site || "unknown";
    let sourcesAdded = 0;

    for (const ep of normalizedEpisodes) {
      const sources = [...ep.sources];
      if (ep.url && !sources.some((s) => s.url === ep.url)) {
        const epKind = classifySourceKind(ep.url);
        if (epKind !== "ephemeral_direct") {
          sources.unshift({ url: ep.url, source_kind: epKind });
        }
      }
      const added = await syncEpisodeSources(mediaItem.id, season, ep.number, sources, defaultSite);
      sourcesAdded += added || 0;
    }
    return sourcesAdded;
  } catch (e) {
    console.error(`[MultiSource] No se pudo sincronizar fuentes para obra legacy ${legacyShowId}:`, e);
    return 0;
  }
}

function enqueueBackfillIfIncomplete(show: {
  id: string;
  description?: string | null;
  poster_url?: string | null;
  banner_url?: string | null;
  genres?: string | null;
  year?: number | null;
}): void {
  try {
    if (showNeedsBackfill(show)) enqueueShowBackfill(show.id);
  } catch {
    /* el backfill jamás puede romper el guardado */
  }
}

async function mergeSequelIntoTwin(
  twin: any,
  showData: any,
  normalizedEpisodes: Array<{ number: number; title: string; url: string; sources: SourceLinkInput[] }>,
  input: SaveShowInput,
  kind: ContentKind,
  detectedSeason: number
) {
  const norm = twin.normalized_title;
  const base = twin.base_normalized_title || twin.normalized_title;

  let maxSeason = 0;
  const mediaItem = await prisma.mediaItem.findFirst({
    where: { OR: [{ base_normalized_title: base, kind }, { normalized_title: norm, kind }] },
    orderBy: { created_at: "asc" },
  });
  if (mediaItem) {
    const agg = await prisma.mediaEpisode.aggregate({
      where: { media_item_id: mediaItem.id },
      _max: { season_number: true },
    });
    maxSeason = agg._max?.season_number ?? 0;
  }
  const seasonNumber = detectedSeason > 1 ? detectedSeason : Math.max(1, maxSeason + 1);

  const lastEp = await prisma.episode.findFirst({
    where: { show_id: twin.id },
    orderBy: { episode_number: "desc" },
    take: 1,
  });
  let nextNumber = (lastEp?.episode_number ?? 0) + 1;
  let added = 0;
  for (const ep of normalizedEpisodes) {
    if (ep.url) {
      const dupe = await prisma.episode.findFirst({ where: { show_id: twin.id, source_url: ep.url } });
      if (dupe) continue;
    }
    await prisma.episode.create({
      data: { show_id: twin.id, episode_number: nextNumber, title: ep.title, source_url: ep.url },
    });
    nextNumber++;
    added++;
  }

  const twinTitleInfo: CanonicalTitleInfo = {
    canonical: twin.title,
    norm,
    baseNorm: base,
    year: twin.year ?? null,
  };
  const sourcesAdded = await syncMediaItemSources({ ...input, season: seasonNumber } as SaveShowInput, kind, twin.id, normalizedEpisodes, twinTitleInfo);

  const patch: any = {};
  if (!twin.mal_id && showData.malId) patch.mal_id = showData.malId;
  if (!twin.anilist_id && showData.anilistId) patch.anilist_id = showData.anilistId;
  if (Object.keys(patch).length > 0) {
    enqueueShowUpdate(twin.id, patch);
  }

  dedupLog(
    `[Deduplication] SECUELA fusionada por TMDB ${showData.tmdbId}: "${showData.title}" → "${twin.title}" como temporada ${seasonNumber} (${added} episodios añadidos, numeración continua).`
  );

  const fresh = await prisma.show.findUnique({
    where: { id: twin.id },
    include: { episodes: { orderBy: { episode_number: "asc" } } },
  });
  return { show: fresh!, isDuplicate: true, episodesAdded: added, sourcesAdded: sourcesAdded || 0 };
}

/**
 * Ensures show passes through AniList / MAL metadata enrichment first,
 * then performs anti-duplication lookup by mal_id and normalized titles,
 * and saves or merges into PostgreSQL.
 */
export async function saveShowWithDeduplication(input: SaveShowInput) {
  const rawParsed = parseRawTitle(String(input.title ?? ""));
  const canonicalTitle = rawParsed.canonical || String(input.title ?? "").trim();
  const parsed = parseTitleQuery(canonicalTitle);
  const rawTitle = parsed.baseTitle || canonicalTitle;
  const kind: ContentKind = (input.content_type || input.category || "anime") as ContentKind;
  const season = input.season ?? rawParsed.season ?? parsed.season ?? 1;

  if (rawParsed.plausible === false || !isPlausibleTitle(canonicalTitle)) {
    throw new Error(`Título implausible descartado por el guard: "${input.title}"`);
  }

  const showData = {
    malId: input.mal_id || null,
    anilistId: input.anilist_id || null,
    tmdbId: input.tmdb_id || null,
    title: isSlugLikeTitle(canonicalTitle) ? cleanSlugToWords(canonicalTitle) : canonicalTitle,
    originalTitle: input.original_title || null,
    japaneseTitle: input.japanese_title || null,
    englishTitle: input.english_title || null,
    description: input.description || "",
    posterUrl: input.poster_url || null,
    bannerUrl: input.banner_url || null,
    rating: input.rating || 8.0,
    year:
      input.year && isPlausibleYear(input.year)
        ? input.year
        : rawParsed.year && isPlausibleYear(rawParsed.year)
          ? rawParsed.year
          : 0,
    status: input.status || "Finalizado",
    genresStr: formatAndNormalizeGenres(input.genres, null)
  };

  let enriched: any = null;
  try {
    const skipEnrich = (input as any)._skipEnrichment === true;
    const preEnriched = Boolean(input.tmdb_id);
    if (skipEnrich) {
      enriched = null;
    } else if (!preEnriched) {
      const identityQueries = [canonicalTitle, input.original_title, input.english_title, input.japanese_title]
        .map((value) => String(value || "").trim())
        .filter((value, index, values) => value && values.findIndex((v) => v.toLowerCase() === value.toLowerCase()) === index)
        .map((value) => (showData.year > 0 ? `${value} ${showData.year}` : value))
        .slice(0, 3);
      for (const query of identityQueries) {
        const candidate = await enrichUniversalMetadata(query, kind);
        if (!enriched) enriched = candidate;
        if (candidate?.tmdb_id || candidate?.mal_id || candidate?.anilist_id) {
          enriched = candidate;
          break;
        }
      }
    } else {
      enriched = {
        tmdb_id: input.tmdb_id ?? undefined,
        original_title: input.original_title ?? undefined,
        poster_path: (input as any).poster_path,
        backdrop_path: (input as any).backdrop_path,
      };
    }
    applyEnrichedMetadata(input, showData, enriched);
    if (enriched?.tmdb_id && !showData.tmdbId) showData.tmdbId = enriched.tmdb_id;
    if (enriched?.original_title && !showData.originalTitle) showData.originalTitle = enriched.original_title;
    if ((input as any).poster_path && !showData.posterUrl) showData.posterUrl = `https://image.tmdb.org/t/p/w780${(input as any).poster_path}`;
    else if (enriched?.poster_path && !showData.posterUrl) showData.posterUrl = `https://image.tmdb.org/t/p/w780${enriched.poster_path}`;
    if ((input as any).backdrop_path && !showData.bannerUrl) showData.bannerUrl = `https://image.tmdb.org/t/p/w1280${(input as any).backdrop_path}`;
    else if (enriched?.backdrop_path && !showData.bannerUrl) showData.bannerUrl = `https://image.tmdb.org/t/p/w1280${enriched.backdrop_path}`;
    (input as any)._enriched = enriched;
  } catch (e) {
    console.error("Enrichment warning during deduplication:", e);
  }

  const normTitle = normalizeTitleKey(showData.title) || normalizeTitle(showData.title);
  const baseNorm = normalizeTitleKey(rawTitle) || normTitle;
  const normJap = showData.japaneseTitle ? normalizeTitle(showData.japaneseTitle) : "";
  const normEng = showData.englishTitle ? normalizeTitle(showData.englishTitle) : "";

  const dedupYear = showData.year > 0 ? showData.year : null;
  const normalizedEpisodes = buildNormalizedEpisodes(input, kind);
  const existingByTmdb = showData.tmdbId
    ? await prisma.show.findFirst({
        where: { tmdb_id: showData.tmdbId, ...tmdbCategoryFilter(kind) },
        include: { episodes: true },
        orderBy: { created_at: "asc" },
      })
    : null;

  // Un TMDB compartido con un marcador explícito S2/S3 no es un episodio
  // adicional de la temporada 1. Encaminarlo al fusionador de secuelas
  // conserva el Show canónico y escribe las fuentes en la temporada correcta.
  if (existingByTmdb && season > 1) {
    const result = await mergeSequelIntoTwin(existingByTmdb, showData, normalizedEpisodes, input, kind, season);
    enqueueBackfillIfIncomplete(result.show);
    return { ...result, season };
  }

  const existingShow =
    existingByTmdb ??
    (await findExistingShowByBase(baseNorm, dedupYear, kind)) ??
    (await findExistingShow(showData.malId ?? showData.tmdbId ? showData.malId : null, normTitle, normEng, normJap));
  const titleInfo: CanonicalTitleInfo = {
    canonical: showData.title,
    norm: normTitle,
    baseNorm,
    year: dedupYear,
  };

  if (existingShow) {
    const result = await mergeShowEpisodes(existingShow, showData, normalizedEpisodes);
    const sourcesAdded = await syncMediaItemSources(input, kind, result.show.id, normalizedEpisodes, titleInfo);
    enqueueBackfillIfIncomplete(result.show);
    return { ...result, sourcesAdded, season };
  }

  if (showData.tmdbId) {
    const twin = await prisma.show.findFirst({
      where: { tmdb_id: showData.tmdbId, ...tmdbCategoryFilter(kind), base_normalized_title: { not: baseNorm } },
      orderBy: { created_at: "asc" },
    });
    if (twin) {
      const result = await mergeSequelIntoTwin(twin, showData, normalizedEpisodes, input, kind, season);
      enqueueBackfillIfIncomplete(result.show);
      return { ...result, season: result.show ? season : season };
    }
  }

  dedupLog(`[Deduplication] Nueva obra verificada sin duplicados. Encolando en buffer RAM...`);

  const rawSource = input.source || input.source_site || "";
  const normalizedSource = rawSource.includes(".")
    ? rawSource.replace(/^www\./, "").split(".")[0] || rawSource
    : rawSource;

  const showId = enqueueShowCreate({
    mal_id: showData.malId,
    anilist_id: showData.anilistId,
    tmdb_id: showData.tmdbId,
    title: showData.title,
    original_title: showData.originalTitle,
    japanese_title: showData.japaneseTitle,
    english_title: showData.englishTitle,
    normalized_title: normTitle,
    base_normalized_title: baseNorm,
    poster_path: enriched?.poster_path || null,
    backdrop_path: enriched?.backdrop_path || null,
    description: showData.description || "Obra multimedia indexada.",
    poster_url: showData.posterUrl,
    banner_url: showData.bannerUrl || showData.posterUrl,
    category: kind,
    rating: showData.rating,
    year: showData.year > 0 ? showData.year : 0,
    status: showData.status,
    genres: showData.genresStr,
    source: normalizedSource,
  });

  enqueueEpisodeCreateMany(
    showId,
    normalizedEpisodes.map((ep) => ({
      show_id: showId,
      episode_number: ep.number,
      title: ep.title,
      source_url: ep.url,
    }))
  );

  const createdShow = {
    id: showId,
    title: showData.title,
    normalized_title: normTitle,
    base_normalized_title: baseNorm,
    category: kind,
    year: showData.year > 0 ? showData.year : 0,
    description: showData.description || "Obra multimedia indexada.",
    poster_url: showData.posterUrl || null,
    banner_url: showData.bannerUrl || null,
    genres: showData.genresStr,
    status: showData.status,
    mal_id: showData.malId,
    anilist_id: showData.anilistId,
    tmdb_id: showData.tmdbId,
    episodes: normalizedEpisodes.map((ep, i) => ({
      id: `${showId}-ep${ep.number}`,
      episode_number: ep.number,
      title: ep.title,
      source_url: ep.url,
    })),
  };

  const sourcesAdded = await syncMediaItemSources(input, kind, createdShow.id, normalizedEpisodes, titleInfo);
  enqueueBackfillIfIncomplete(createdShow);

  return {
    show: createdShow as any,
    isDuplicate: false,
    episodesAdded: normalizedEpisodes.length,
    sourcesAdded,
    season,
  };
}

export async function getShowsFromDb(search?: string, category?: string) {
  let where: any = {};

  if (category) {
    where.category = { contains: category };
  }

  if (search) {
    const s = search.toLowerCase().trim();
    where.OR = [
      { title: { contains: s } },
      { english_title: { contains: s } },
      { japanese_title: { contains: s } },
      { genres: { contains: s } },
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

export async function getShowsFromDbLite(
  search?: string,
  category?: string,
  page?: number,
  limit?: number
) {
  const pageNum = Math.max(1, page || 1);
  const pageSize = Math.min(50000, Math.max(1, limit || 500));
  const skip = (pageNum - 1) * pageSize;

  if (search && search.trim().length >= 2) {
    const s = search.trim();
    const tsQuery = s.split(/\s+/).join(" & ");

    let categoryFilter = "";
    const params: any[] = [tsQuery, s.toLowerCase(), pageSize, skip];
    let paramIdx = 4;

    if (category) {
      paramIdx++;
      params.push(`%${category.toLowerCase()}%`);
      categoryFilter = `AND LOWER(category) LIKE $${paramIdx}`;
    }

    const showsQuery = `
      SELECT
        "id", "title", "original_title", "japanese_title", "english_title",
        "normalized_title", "description", "poster_url", "banner_url",
        "poster_path", "backdrop_path", "category", "rating", "year",
        "status", "genres", "created_at",
        ts_rank(search_vector, plainto_tsquery('simple', $1)) AS rank
      FROM "Show"
      WHERE (
        search_vector @@ plainto_tsquery('simple', $1)
        OR LOWER(title) LIKE $2
        OR LOWER("english_title") LIKE $2
        OR LOWER("japanese_title") LIKE $2
        OR LOWER(genres) LIKE $2
      )
      ${categoryFilter}
      ORDER BY rank DESC, "created_at" DESC
      LIMIT $3 OFFSET $4
    `;

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM "Show"
      WHERE (
        search_vector @@ plainto_tsquery('simple', $1)
        OR LOWER(title) LIKE $2
        OR LOWER("english_title") LIKE $2
        OR LOWER("japanese_title") LIKE $2
        OR LOWER(genres) LIKE $2
      )
      ${categoryFilter}
    `;

    const [shows, countResult] = await Promise.all([
      prisma.$queryRawUnsafe(showsQuery, ...params),
      prisma.$queryRawUnsafe(countQuery, tsQuery, `%${s.toLowerCase()}%`, ...(category ? [`%${category.toLowerCase()}%`] : [])),
    ]);

    const total = (countResult as any[])[0]?.total || 0;
    return { shows, total, page: pageNum, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  let where: any = {};
  if (category) {
    where.category = { contains: category };
  }

  const [shows, total] = await Promise.all([
    prisma.show.findMany({
      where,
      select: {
        id: true,
        title: true,
        original_title: true,
        japanese_title: true,
        english_title: true,
        normalized_title: true,
        description: true,
        poster_url: true,
        banner_url: true,
        poster_path: true,
        backdrop_path: true,
        category: true,
        rating: true,
        year: true,
        status: true,
        genres: true,
        created_at: true,
        _count: { select: { episodes: true } },
      },
      orderBy: { created_at: "desc" },
      skip,
      take: pageSize,
    }),
    prisma.show.count({ where }),
  ]);

  return { shows, total, page: pageNum, pageSize, totalPages: Math.ceil(total / pageSize) };
}

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

export async function deleteShowFromDb(id: string) {
  return prisma.show.delete({
    where: { id },
  });
}

export async function clearAllShowsFromDb() {
  await prisma.episode.deleteMany({});
  await prisma.show.deleteMany({});
  await prisma.mediaItem.deleteMany({});
}

export interface UpdateShowPatch {
  title?: string;
  description?: string;
  genres?: string | string[];
  year?: number;
  rating?: number;
  status?: string;
  category?: string;
  poster_url?: string | null;
  banner_url?: string | null;
  japanese_title?: string | null;
  english_title?: string | null;
}

export async function updateShowFields(showId: string, patch: UpdateShowPatch) {
  const existing = await prisma.show.findUnique({ where: { id: showId } });
  if (!existing) return null;

  const data: Record<string, unknown> = {};

  if (typeof patch.title === "string") {
    const raw = patch.title.replace(/\s+/g, " ").trim();
    if (raw) {
      const canonical = parseRawTitle(raw).canonical || raw;
      const parsed = parseTitleQuery(canonical);
      const baseTitle = parsed.baseTitle || canonical;
      const normTitle = normalizeTitleKey(canonical) || normalizeTitle(canonical);
      data.title = canonical;
      data.normalized_title = normTitle;
      data.base_normalized_title = normalizeTitleKey(baseTitle) || normTitle;
    }
  }
  if (typeof patch.description === "string") data.description = patch.description;
  if (patch.genres !== undefined && patch.genres !== null) {
    data.genres = formatAndNormalizeGenres(patch.genres, null);
  }
  if (typeof patch.year === "number" && Number.isFinite(patch.year)) data.year = Math.round(patch.year);
  if (typeof patch.rating === "number" && Number.isFinite(patch.rating)) data.rating = patch.rating;
  if (typeof patch.status === "string" && patch.status.trim()) data.status = patch.status.trim();
  if (typeof patch.category === "string" && patch.category.trim()) data.category = patch.category.trim();
  if (patch.poster_url !== undefined) data.poster_url = patch.poster_url;
  if (patch.banner_url !== undefined) data.banner_url = patch.banner_url;
  if (patch.japanese_title !== undefined) data.japanese_title = patch.japanese_title;
  if (patch.english_title !== undefined) data.english_title = patch.english_title;

  if (Object.keys(data).length === 0) {
    return getShowByIdFromDb(showId);
  }

  enqueueShowUpdate(showId, data);
  return getShowByIdFromDb(showId);
}

export interface RefreshStreamsSummary {
  episodes_checked: number;
  sources_added: number;
  episodes_without_streams: number;
}

function siteOfUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "") || "unknown";
    return host.split(".")[0] || host;
  } catch {
    return "unknown";
  }
}

export async function refreshShowStreams(showId: string): Promise<RefreshStreamsSummary> {
  const summary: RefreshStreamsSummary = { episodes_checked: 0, sources_added: 0, episodes_without_streams: 0 };

  const show = await prisma.show.findUnique({
    where: { id: showId },
    include: { episodes: { orderBy: { episode_number: "asc" } } },
  });
  if (!show) return summary;

  const targetEpisodes = show.episodes.filter((ep: any) => ep.source_url);
  summary.episodes_checked = targetEpisodes.length;
  if (targetEpisodes.length === 0) return summary;

  const kind = (show.category || "anime") as ContentKind;
  const norm = show.normalized_title || normalizeTitle(show.title);
  const baseNorm = show.base_normalized_title || norm;
  const season = parseTitleQuery(show.title).season ?? 1;

  const itemCandidates = await prisma.mediaItem.findMany({
    where: {
      OR: [
        { base_normalized_title: baseNorm, kind },
        ...(baseNorm !== norm ? [{ normalized_title: norm, kind }] : []),
      ],
    },
    orderBy: { created_at: "asc" },
  });
  const mediaItem = pickYearCompatible(itemCandidates, show.year ?? null);
  if (!mediaItem) return summary;

  for (const ep of targetEpisodes) {
    try {
      const extracted = await extractStreamFromUrl(ep.source_url);
      const canonicalSources = Array.from(
        new Set(
          [ep.source_url, extracted.stream_url, ...(extracted.all_available_streams || [])]
            .filter((url): url is string => typeof url === "string" && Boolean(url.trim()))
        )
      ).filter((url) => classifySourceKind(url) !== "ephemeral_direct");
      if (canonicalSources.length === 0) {
        summary.episodes_without_streams++;
        continue;
      }

      const episodeSite = siteOfUrl(ep.source_url);
      const mediaEpisode = await prisma.mediaEpisode.findUnique({
        where: {
          media_item_id_season_number_episode_number: {
            media_item_id: mediaItem.id,
            season_number: season,
            episode_number: ep.episode_number,
          },
        },
        include: { links: true },
      });
      const knownUrls = new Set((mediaEpisode?.links || []).map((l) => l.url));
      summary.sources_added += canonicalSources.filter((url) => !knownUrls.has(url)).length;

      await syncEpisodeSources(
        mediaItem.id,
        season,
        ep.episode_number,
        canonicalSources.map((url) => ({
          url,
          source_site: episodeSite,
          source_kind: classifySourceKind(url),
        })),
        "unknown"
      );
    } catch (e) {
      summary.episodes_without_streams++;
      console.error(`[RefreshStreams] No se pudo resolver '${ep.source_url}' (obra '${show.title}'):`, e);
    }
  }

  return summary;
}

export interface QuickSyncInput {
  title?: string;
  /** Temporada detectada en el título/slug de la ficha reescaneada. */
  season?: number | null;
  episodes: Array<{ number: number; title: string; url: string; sources?: SourceLinkInput[] }>;
  source_site?: string;
}

export async function quickSyncKnownShow(
  showId: string,
  data: QuickSyncInput
): Promise<{ added: number; sourcesAdded: number }> {
  const show = await prisma.show.findUnique({ where: { id: showId }, include: { episodes: true } });
  if (!show) return { added: 0, sourcesAdded: 0 };

  const kind = (show.category || "anime") as ContentKind;
  const normalizedEpisodes = buildNormalizedEpisodes({
    title: data.title || show.title,
    category: kind,
    source_site: data.source_site,
    episodes: data.episodes,
  }, kind);

  const showData: any = {
    malId: null,
    anilistId: null,
    title: data.title || show.title,
  };

  const season = data.season ?? parseTitleQuery(data.title || "").season ?? parseTitleQuery(show.title).season ?? 1;

  // El modelo legacy `Episode` no tiene columna de temporada. Para una
  // reimportación S2/S3 debemos conservar la numeración de la fuente en
  // `MediaEpisode` (más abajo) y, en paralelo, anexar los episodios nuevos al
  // final del Show legacy; de lo contrario el episodio 1 de S2 se descartaría
  // como si fuera el episodio 1 de S1.
  const result = season > 1
    ? await mergeShowEpisodes(show, showData, [])
    : await mergeShowEpisodes(show, showData, normalizedEpisodes);
  let legacyAdded = result.episodesAdded;
  if (season > 1 && normalizedEpisodes.length > 0) {
    const knownUrls = new Set(show.episodes.map((episode: any) => String(episode.source_url || "").trim()).filter(Boolean));
    const knownUntitled = new Set(
      show.episodes
        .filter((episode: any) => !episode.source_url)
        .map((episode: any) => normalizeTitleKey(String(episode.title || "")))
        .filter(Boolean),
    );
    const missingSeasonEpisodes = normalizedEpisodes.filter((episode) =>
      episode.url ? !knownUrls.has(episode.url) : !knownUntitled.has(normalizeTitleKey(episode.title)),
    );
    if (missingSeasonEpisodes.length > 0) {
      const maxLegacyNumber = show.episodes.reduce(
        (max: number, episode: any) => Math.max(max, Number(episode.episode_number) || 0),
        0,
      );
      await prisma.episode.createMany({
        data: missingSeasonEpisodes.map((episode, index) => ({
          show_id: show.id,
          episode_number: maxLegacyNumber + index + 1,
          title: episode.title,
          source_url: episode.url,
        })),
      });
      legacyAdded = missingSeasonEpisodes.length;
    }
  }

  const titleInfo: CanonicalTitleInfo = {
    canonical: show.title,
    norm: show.normalized_title,
    baseNorm: show.base_normalized_title || show.normalized_title,
    year: show.year ?? null,
  };
  const sourcesAdded = await syncMediaItemSources(
    { title: show.title, source_site: data.source_site, season } as SaveShowInput,
    kind,
    show.id,
    normalizedEpisodes,
    titleInfo
  );

  return { added: legacyAdded, sourcesAdded: sourcesAdded || 0 };
}
