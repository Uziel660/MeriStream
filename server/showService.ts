// server/showService.ts
import { prisma, Prisma, normalizeTitle } from "./db";
import { enqueueShowBackfill, showNeedsBackfill } from "./metadataBackfill";
import { enrichUniversalMetadata, cleanQueryTitle, parseTitleQuery } from "./metadataEngine";
import { applyEnrichmentGapFill, hasSubstantiveText, isPlausibleYear } from "./metadataMerge";
import { ContentKind, SourceLinkInput, SourceKind } from "./types";
import { classifySourceKind } from "./resolutionMetadata";
import { getStreamTier } from "./utils/streamSorter";
import { normalizeTitleKey, parseRawTitle, isPlausibleTitle, isSlugLikeTitle, cleanSlugToWords } from "./utils/titleNormalizer";
import { formatAndNormalizeGenres } from "./utils/genreNormalizer";
import { canonicalCatalogUrl, isInvalidCatalogSource } from "./catalogIntegrity";
import { dedupeCatalogShows } from "./catalogDedup";
import {
  buildDisplayEpisodes,
  filterMainPathLinks,
  playbackKindForCategory,
} from "./showEpisodePolicy";
import { PROVIDER_POLICIES, isProviderAllowedInMainPath, normalizeProviderId } from "./providers/providerPolicy";
import { getCatalogPolicy, normalizeShowProviderOverrides } from "./catalogPolicy";
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

function positiveCatalogNumber(value: unknown, fallback = 1): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export interface SaveShowInput {
  mal_id?: number | null;
  anilist_id?: number | null;
  kitsu_id?: string | null;
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
    /** Temporada que aporta el adaptador cuando la ficha la publica. */
    season?: number;
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
    kitsuId: string | null;
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
      const rawEpisodeNumber = Number(ep.number ?? ep.episode_number);
      // Algunos catálogos publican su primer episodio como "0". El contrato
      // interno empieza en 1; usar la posición del adaptador evita persistir
      // MediaEpisode inválidos y conserva el orden de la ficha.
      const epNum = Number.isFinite(rawEpisodeNumber) && rawEpisodeNumber > 0
        ? rawEpisodeNumber
        : idx + 1;
      const primaryUrl = ep.url || ep.source_url || (ep.sources && ep.sources[0]?.url) || "";
      const epSources: SourceLinkInput[] = [];
      const seen = new Set<string>();

      if (primaryUrl && !isInvalidCatalogSource(primaryUrl)) {
        const kind = classifySourceKind(primaryUrl);
        if (kind !== "ephemeral_direct") {
          epSources.push({ url: primaryUrl, source_site: defaultSite, source_kind: kind });
          seen.add(sourceIdentityKey(primaryUrl));
        }
      }

      if (ep.sources) {
        for (const s of ep.sources) {
          if (s?.url && !isInvalidCatalogSource(s.url) && !seen.has(sourceIdentityKey(s.url))) {
            const kind = classifySourceKind(s.url);
            if (kind !== "ephemeral_direct") {
              epSources.push({ ...s, source_site: s.source_site || defaultSite, source_kind: kind });
              seen.add(sourceIdentityKey(s.url));
            }
          }
        }
      }

      const epSeason = Number(ep.season);
      return {
        number: epNum,
        ...(Number.isFinite(epSeason) && epSeason > 0 ? { season: epSeason } : {}),
        title: ep.title || (kind === "movie" ? "Película Completa" : `Episodio ${epNum}`),
        url: epSources[0]?.url || "",
        sources: epSources,
      };
    })
    .filter((episode) => Boolean(episode.url));

  if (normalizedEpisodes.length === 0) {
    // Para series/anime NUNCA se debe usar la landing page/URL de serie como stream de un episodio.
    // Solo se permite fallback si es película o si la URL es un medio/stream directo válido.
    const fallbackUrl = detectedStreams[0] || (input as any).source_url || (input as any).url || "";
    if (fallbackUrl && (kind === "movie" || !isInvalidCatalogSource(fallbackUrl))) {
      const fallbackKind = classifySourceKind(fallbackUrl);
      const fallbackSources = detectedStreams
        .filter((st) => !isInvalidCatalogSource(st) && classifySourceKind(st) !== "ephemeral_direct")
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
  // Toda escritura a MediaEpisode pasa por aquí en la importación normal.
  // Mantener la defensa en el borde evita que un adaptador que publique
  // "episodio 0" vuelva a crear claves inválidas durante una carrera.
  const safeSeason = positiveCatalogNumber(season, 1);
  const safeEpisodeNumber = positiveCatalogNumber(episodeNumber, 1);
  const cleanSources = (sources || []).filter(
    (s) => s && s.url && typeof s.url === "string" && s.url.trim() && !isInvalidCatalogSource(s.url.trim())
  );
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
        season_number: safeSeason,
        episode_number: safeEpisodeNumber,
      },
    },
    create: { media_item_id: mediaItemId, season_number: safeSeason, episode_number: safeEpisodeNumber },
  });

  for (const src of persistentSources) {
    const rawUrl = src.url.trim();
    const kind = classifySourceKind(rawUrl);
    const linkType = src.link_type || (kind === "embed" ? "embed" : kind === "page" ? "page" : "direct");
    const site = src.source_site || defaultSite || "unknown";
    const defaultRendition = defaultRenditionForSource(site, rawUrl);

    const existing = await prisma.sourceLink.findFirst({
      where: {
        url: rawUrl,
        source_site: site,
        media_episode: {
          media_item_id: mediaItemId,
          season_number: safeSeason,
          episode_number: safeEpisodeNumber,
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
          season_number: safeSeason,
          episode_number: safeEpisodeNumber,
        },
        data: {
          source_site: site,
          url: rawUrl,
          link_type: linkType,
          language: src.language ?? null,
          audio_language: src.audio_language ?? defaultRendition.audio_language ?? null,
          subtitle_language: src.subtitle_language ?? defaultRendition.subtitle_language ?? null,
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
      const audioLanguage = src.audio_language || defaultRendition.audio_language;
      const subtitleLanguage = src.subtitle_language || defaultRendition.subtitle_language;
      if (audioLanguage && existing.audio_language !== audioLanguage) evidence.audio_language = audioLanguage;
      if (subtitleLanguage && existing.subtitle_language !== subtitleLanguage) evidence.subtitle_language = subtitleLanguage;
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
  if (!existingShow.kitsu_id && showData.kitsuId) updatePayload.kitsu_id = showData.kitsuId;
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
  normalizedEpisodes: Array<{ number: number; season?: number; title: string; url: string; sources: SourceLinkInput[] }>,
  titleInfo: CanonicalTitleInfo
) {
  try {
    const canonical = titleInfo.canonical || input.title;
    const norm = titleInfo.norm || normalizeTitle(canonical);
    if (!norm) return 0;

    const baseNorm = titleInfo.baseNorm || norm;
    const season = positiveCatalogNumber(input.season ?? parseTitleQuery(canonical).season, 1);
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
      const targetSeason = (ep as any).season || season;
      const added = await syncEpisodeSources(mediaItem.id, targetSeason, ep.number, sources, defaultSite);
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
  const urlsToCheck = normalizedEpisodes
    .map((ep) => ep.url)
    .filter((url): url is string => typeof url === "string" && url.trim().length > 0);
  const existingDupes = urlsToCheck.length > 0
    ? await prisma.episode.findMany({
        where: { show_id: twin.id, source_url: { in: urlsToCheck } },
        select: { source_url: true },
      })
    : [];
  const existingUrls = new Set(existingDupes.map((episode) => episode.source_url));
  const episodesToCreate: Array<{ show_id: string; episode_number: number; title: string; source_url: string }> = [];

  for (const ep of normalizedEpisodes) {
    if (ep.url && existingUrls.has(ep.url)) continue;
    if (ep.url) existingUrls.add(ep.url);
    episodesToCreate.push({
      show_id: twin.id,
      episode_number: nextNumber,
      title: ep.title,
      source_url: ep.url,
    });
    nextNumber++;
  }
  if (episodesToCreate.length > 0) {
    await prisma.episode.createMany({ data: episodesToCreate });
    added = episodesToCreate.length;
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
  if (!twin.kitsu_id && showData.kitsuId) patch.kitsu_id = showData.kitsuId;
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
  const locatorOnlyImport = (input as any)._skipEnrichment === true;
  const rawParsed = parseRawTitle(String(input.title ?? ""));
  const canonicalTitle = rawParsed.canonical || String(input.title ?? "").trim();
  const parsed = parseTitleQuery(canonicalTitle);
  const rawTitle = parsed.baseTitle || canonicalTitle;
  const kind: ContentKind = (input.content_type || input.category || "anime") as ContentKind;
  const season = positiveCatalogNumber(input.season ?? rawParsed.season ?? parsed.season, 1);

  if (rawParsed.plausible === false || !isPlausibleTitle(canonicalTitle)) {
    throw new Error(`Título implausible descartado por el guard: "${input.title}"`);
  }

  const showData = {
    malId: input.mal_id || null,
    anilistId: input.anilist_id || null,
    kitsuId: input.kitsu_id || null,
    tmdbId: input.tmdb_id || null,
    title: isSlugLikeTitle(canonicalTitle) ? cleanSlugToWords(canonicalTitle) : canonicalTitle,
    originalTitle: input.original_title || null,
    japaneseTitle: input.japanese_title || null,
    englishTitle: input.english_title || null,
    description: locatorOnlyImport ? String(input.description ?? "") : input.description || "",
    posterUrl: input.poster_url || null,
    bannerUrl: input.banner_url || null,
    // Las importaciones de catálogo solo prueban existencia/localizadores. No
    // introducir un rating ficticio que parezca metadata de TMDB.
    rating: locatorOnlyImport
      ? (typeof input.rating === "number" && Number.isFinite(input.rating) ? input.rating : 0)
      : input.rating || 8.0,
    year:
      input.year && isPlausibleYear(input.year)
        ? input.year
        : rawParsed.year && isPlausibleYear(rawParsed.year)
          ? rawParsed.year
          : 0,
    status: input.status || "Finalizado",
    genresStr: locatorOnlyImport ? String(input.genres ?? "") : formatAndNormalizeGenres(input.genres, null)
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
        if (candidate?.tmdb_id || candidate?.mal_id || candidate?.anilist_id || candidate?.kitsu_id) {
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
    if (!locatorOnlyImport) enqueueBackfillIfIncomplete(result.show);
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
    if (!locatorOnlyImport) enqueueBackfillIfIncomplete(result.show);
    return { ...result, sourcesAdded, season };
  }

  if (showData.tmdbId) {
    const twin = await prisma.show.findFirst({
      where: { tmdb_id: showData.tmdbId, ...tmdbCategoryFilter(kind), base_normalized_title: { not: baseNorm } },
      orderBy: { created_at: "asc" },
    });
    if (twin) {
      const result = await mergeSequelIntoTwin(twin, showData, normalizedEpisodes, input, kind, season);
      if (!locatorOnlyImport) enqueueBackfillIfIncomplete(result.show);
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
    kitsu_id: showData.kitsuId,
    tmdb_id: showData.tmdbId,
    title: showData.title,
    original_title: showData.originalTitle,
    japanese_title: showData.japaneseTitle,
    english_title: showData.englishTitle,
    normalized_title: normTitle,
    base_normalized_title: baseNorm,
    poster_path: enriched?.poster_path || null,
    backdrop_path: enriched?.backdrop_path || null,
    description: showData.description || (locatorOnlyImport ? "" : "Obra multimedia indexada."),
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
    description: showData.description || (locatorOnlyImport ? "" : "Obra multimedia indexada."),
    poster_url: showData.posterUrl || null,
    banner_url: showData.bannerUrl || null,
    genres: showData.genresStr,
    status: showData.status,
    mal_id: showData.malId,
    anilist_id: showData.anilistId,
    kitsu_id: showData.kitsuId,
    tmdb_id: showData.tmdbId,
    episodes: normalizedEpisodes.map((ep, i) => ({
      id: `${showId}-ep${ep.number}`,
      episode_number: ep.number,
      title: ep.title,
      source_url: ep.url,
    })),
  };

  const sourcesAdded = await syncMediaItemSources(input, kind, createdShow.id, normalizedEpisodes, titleInfo);
  if (!locatorOnlyImport) enqueueBackfillIfIncomplete(createdShow);

  return {
    show: createdShow as any,
    isDuplicate: false,
    episodesAdded: normalizedEpisodes.length,
    sourcesAdded,
    season,
  };
}

export function expandSearchVariants(query: string): string[] {
  const romanToArabic: Record<string, string> = {
    i: "1", ii: "2", iii: "3", iv: "4", v: "5",
    vi: "6", vii: "7", viii: "8", ix: "9", x: "10"
  };
  const arabicToRoman: Record<string, string> = {
    "1": "i", "2": "ii", "3": "iii", "4": "iv", "5": "v",
    "6": "vi", "7": "vii", "8": "viii", "9": "ix", "10": "x"
  };

  // Keep the original spelling for PostgreSQL full-text search, but also add
  // an accent-free form.  The latter lets a query such as "muerte en familia"
  // match a stored title with "Muerte en família" without requiring the
  // unaccent extension (which is not present in every local deployment).
  const stripDiacritics = (value: string) => value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const variants = new Set<string>([query.toLowerCase(), stripDiacritics(query)]);

  for (const [arabic, roman] of Object.entries(arabicToRoman)) {
    const reg = new RegExp(`\\b${arabic}\\b`, "gi");
    if (reg.test(query)) {
      variants.add(query.replace(reg, roman).toLowerCase());
    }
  }

  for (const [roman, arabic] of Object.entries(romanToArabic)) {
    const reg = new RegExp(`\\b${roman}\\b`, "gi");
    if (reg.test(query)) {
      variants.add(query.replace(reg, arabic).toLowerCase());
    }
  }

  return Array.from(variants);
}

function searchTitleFieldsSql(): string[] {
  // `translate` is deliberately kept in the fallback expression instead of
  // normalising every row on every request.  Prefix search only runs when the
  // indexed/full-text path produces no hit, so ordinary catalog requests stay
  // on the fast GIN/LIKE path.
  const accentMap = "'áéíóúüñÁÉÍÓÚÜÑ'";
  const plainMap = "'aeiouunAEIOUUN'";
  return ["title", "english_title", "japanese_title", "original_title"].map((column) =>
    `translate(lower(coalesce(\"${column}\", '')), ${accentMap}, ${plainMap})`
  );
}

function fuzzySearchPrefixes(query: string): string[] {
  const normalized = query
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return [...new Set(normalized.split(/\s+/)
    .filter((token) => token.length >= 3)
    // Three characters are enough to correct a single typo while keeping a
    // prefix query selective.  Longer words use four/five characters to avoid
    // pulling the whole catalog into the fuzzy pass.
    .map((token) => token.slice(0, token.length >= 6 ? 5 : 3)))];
}

export async function getShowsFromDb(search?: string, category?: string) {
  let where: any = {};

  if (category) {
    where.category = { contains: category, mode: "insensitive" };
  }

  if (search) {
    const s = search.trim();
    const variants = expandSearchVariants(s);
    where.OR = variants.flatMap((v) => [
      { title: { contains: v, mode: "insensitive" } },
      { english_title: { contains: v, mode: "insensitive" } },
      { japanese_title: { contains: v, mode: "insensitive" } },
      { genres: { contains: v, mode: "insensitive" } },
    ]);
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

type LiteShowsOptions = {
  /** Public catalog mode: hide legacy-only rows without an active source. */
  onlyMainPath?: boolean;
  /** Admin mode can include legacy rows without returning duplicate identities. */
  dedupe?: boolean;
  /** Optional admin filters kept server-side so pagination remains accurate. */
  year?: number;
  genre?: string;
  sort?: "recientes" | "rating" | "anio" | "az";
  /** Admin identity queue: only works that still lack a TMDB id. */
  missingTmdb?: boolean;
  /** Admin identity queue for any selected external namespace. */
  identity?: "missing_tmdb" | "missing_any" | "missing_imdb" | "missing_mal" | "missing_anilist" | "missing_kitsu" | "missing_anidb" | "missing_tvdb";
};

/**
 * Run Prisma `IN` lookups in bounded batches. Prisma expands every item in an
 * `in` filter (including nested relation filters) into a prepared-statement
 * bind variable; loading the full public catalog in one query can therefore
 * exceed PostgreSQL's 32,767-variable limit.
 */
async function findManyInChunks<TValue, TResult>(
  values: readonly TValue[],
  query: (chunk: TValue[]) => Promise<TResult[]>,
  chunkSize = 500,
): Promise<TResult[]> {
  if (values.length === 0) return [];

  const chunks: TValue[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(Array.from(values.slice(index, index + chunkSize)));
  }

  const results: TResult[] = [];
  // A public catalog request can invoke this helper for ids, TMDB ids, base
  // titles and legacy episodes at the same time. Running several nested-link
  // queries in parallel exhausts PostgreSQL's small shared-memory segment on
  // the local deployment, leaving the portada empty even though the admin
  // catalog is populated. Keep this bounded to one chunk at a time; the
  // endpoint still remains cancellable and avoids the database storm.
  const concurrency = 1;
  for (let index = 0; index < chunks.length; index += concurrency) {
    const batch = await Promise.all(chunks.slice(index, index + concurrency).map(query));
    results.push(...batch.flat());
  }
  return results;
}

export async function filterShowsToMainPath(shows: any[]): Promise<any[]> {
  if (shows.length === 0) return shows;

  const ids = [...new Set(shows.map((show) => String(show.id)).filter(Boolean))];
  const tmdbIds = [...new Set(shows
    .map((show) => Number(show.tmdb_id))
    .filter((value) => Number.isInteger(value) && value > 0))];
  const baseTitles = [...new Set(shows
    .map((show) => String(show.base_normalized_title || show.normalized_title || "").trim())
    .filter(Boolean))];
  const globalCatalogPolicy = getCatalogPolicy();
  const workMainProviders = new Set(shows.flatMap((show) => normalizeShowProviderOverrides(show.main_path_overrides).main));
  const mainPathSourceSites = [...new Set(
    Object.values(PROVIDER_POLICIES)
      .filter((policy) => ["movie", "series", "anime"].some((kind) =>
        isProviderAllowedInMainPath(policy.id, kind as any) || globalCatalogPolicy.providerModes[policy.id] === "main" || workMainProviders.has(policy.id)
      ))
      .flatMap((policy) => [policy.id, ...(policy.hosts || [])])
      .concat([...workMainProviders])
      .map((value) => String(value).toLowerCase())
  )];
  const sourceLinkMainPathWhere = {
    OR: [
      { source_site: { in: mainPathSourceSites } },
      { main_path_override: true },
    ],
  } as const;

  const mediaItemSelect = {
    id: true,
    tmdb_id: true,
    base_normalized_title: true,
    normalized_title: true,
    kind: true,
    episodes: {
      where: { links: { some: sourceLinkMainPathWhere } },
      select: {
        links: {
          where: sourceLinkMainPathWhere,
          select: {
            url: true,
            source_site: true,
            host: true,
            link_type: true,
            audio_language: true,
            subtitle_language: true,
            main_path_override: true,
          },
        },
      },
    },
  } as const;

  // Keep each IN list below PostgreSQL's prepared-statement bind-variable
  // ceiling. Most canonical rows share the legacy Show id; TMDB/title matches
  // cover rows imported before the id mirror was added.
  // Keep the four lookup families sequential as well. Each family can return
  // thousands of nested SourceLink rows; Promise.all here multiplied the
  // memory footprint even after chunking the IN predicates.
  const mediaById = await findManyInChunks(ids, (chunk) => prisma.mediaItem.findMany({
    where: { id: { in: chunk }, episodes: { some: { links: { some: sourceLinkMainPathWhere } } } },
    select: mediaItemSelect,
  }));
  const mediaByTmdb = await findManyInChunks(tmdbIds, (chunk) => prisma.mediaItem.findMany({
    where: { tmdb_id: { in: chunk }, episodes: { some: { links: { some: sourceLinkMainPathWhere } } } },
    select: mediaItemSelect,
  }));
  const mediaByBase = await findManyInChunks(baseTitles, (chunk) => prisma.mediaItem.findMany({
    where: { base_normalized_title: { in: chunk }, episodes: { some: { links: { some: sourceLinkMainPathWhere } } } },
    select: mediaItemSelect,
  }));
  const legacyEpisodes = await findManyInChunks(ids, (chunk) => prisma.episode.findMany({
    where: { show_id: { in: chunk }, source_url: { not: "" } },
    select: { show_id: true, source_url: true },
    orderBy: { episode_number: "asc" },
  }));
  const mediaItems = [...mediaById, ...mediaByTmdb, ...mediaByBase];

  const legacyByShow = new Map<string, Array<{ url: string }>>();
  for (const episode of legacyEpisodes) {
    const url = String(episode.source_url || "").trim();
    if (!url) continue;
    const list = legacyByShow.get(episode.show_id) || [];
    list.push({ url });
    legacyByShow.set(episode.show_id, list);
  }

  const itemsByKey = new Map<string, any[]>();
  const addItemKey = (key: string | null | undefined, item: any) => {
    const normalized = String(key || "").trim();
    if (!normalized) return;
    const list = itemsByKey.get(normalized) || [];
    list.push(item);
    itemsByKey.set(normalized, list);
  };
  for (const item of mediaItems) {
    addItemKey(`id:${item.id}`, item);
    if (item.tmdb_id != null) addItemKey(`tmdb:${item.tmdb_id}`, item);
    addItemKey(`base:${item.base_normalized_title || item.normalized_title}`, item);
  }

  return shows.filter((show) => {
    const kind = playbackKindForCategory(show.category);
    const candidateItems = [
      ...(itemsByKey.get(`id:${show.id}`) || []),
      ...(show.tmdb_id != null ? itemsByKey.get(`tmdb:${show.tmdb_id}`) || [] : []),
      ...(itemsByKey.get(`base:${show.base_normalized_title || show.normalized_title}`) || []),
    ];
    const uniqueItems = [...new Map(candidateItems.map((item) => [item.id, item])).values()];
    const canonicalPlayable = uniqueItems.some((item) =>
      (item.episodes || []).some((episode: any) =>
        filterMainPathLinks(episode.links || [], kind, show.main_path_overrides).length > 0
      )
    );
    if (canonicalPlayable) return true;

    return (legacyByShow.get(String(show.id)) || []).some((episode) =>
      filterMainPathLinks([{ url: episode.url }], kind, show.main_path_overrides).length > 0
    );
  });
}

function defaultRenditionForSource(sourceSite: string, url: string): Pick<SourceLinkInput, "audio_language" | "subtitle_language"> {
  const provider = normalizeProviderId(sourceSite);
  if (provider === "latanime") {
    const isCastellano = /(?:-|\b)castellano\b/i.test(url);
    const isCatalan = /(?:-|\b)catalan\b|-catala\b/i.test(url);
    const isLatino = /(?:-|\b)latino\b/i.test(url);
    if (isCastellano) return { audio_language: "es-ES" };
    if (isCatalan) return { audio_language: "ca" };
    if (isLatino) return { audio_language: "es-419" };
    return { audio_language: "ja", subtitle_language: "es" };
  }
  if (provider === "cinecalidad" || provider === "gnula") {
    return { audio_language: "es" };
  }
  if (provider === "zokoanime") {
    const isDub = /\/dub(?:[/?#]|$)/i.test(url);
    // `/sub` is Japanese audio; the subtitle language comes from the
    // provider payload (often English) or OpenSubtitles when configured.
    return isDub ? { audio_language: "en" } : { audio_language: "ja" };
  }
  return {};
}

export async function getShowsFromDbLite(
  search?: string,
  category?: string,
  page?: number,
  limit?: number,
  options: LiteShowsOptions = {},
) {
  const onlyMainPath = options.onlyMainPath !== false;
  const pageNum = Math.max(1, page || 1);
  const pageSize = Math.min(50000, Math.max(1, limit || 500));
  const skip = (pageNum - 1) * pageSize;

  if (search && search.trim().length >= 1) {
    const s = search.trim();
    const tsQuery = s;
    const variants = expandSearchVariants(s);
    const titleFields = searchTitleFieldsSql().map((field) => Prisma.raw(field));
    const likeConditions = variants.map((variant) => {
      const pattern = `%${variant}%`;
      const fields = [
        Prisma.sql`LOWER(title) LIKE ${pattern}`,
        Prisma.sql`LOWER("english_title") LIKE ${pattern}`,
        Prisma.sql`LOWER("japanese_title") LIKE ${pattern}`,
        Prisma.sql`LOWER("original_title") LIKE ${pattern}`,
        Prisma.sql`LOWER(genres) LIKE ${pattern}`,
        Prisma.sql`LOWER(COALESCE(imdb_id, '')) LIKE ${pattern}`,
        Prisma.sql`LOWER(COALESCE(anilist_id, '')) LIKE ${pattern}`,
        Prisma.sql`LOWER(COALESCE(kitsu_id, '')) LIKE ${pattern}`,
        Prisma.sql`LOWER(COALESCE(anidb_id, '')) LIKE ${pattern}`,
        ...titleFields.map((field) => Prisma.sql`${field} LIKE ${pattern}`),
      ];
      return Prisma.sql`(${Prisma.join(fields, " OR ")})`;
    });

    const identityMatch = s.match(/^(tmdb|imdb|tvdb|mal|anilist|kitsu|anidb)\s*[:#]\s*(.+)$/i);
    const identityNamespace = identityMatch?.[1]?.toLowerCase();
    const identityValue = identityMatch?.[2]?.trim() || null;
    const numericTmdbId = /^\d+$/.test(s) ? Number(s) : identityNamespace && /^(tmdb|tvdb|mal|anilist|anidb)$/.test(identityNamespace) && /^\d+$/.test(identityValue || "") ? Number(identityValue) : null;
    if (identityNamespace && identityValue && (!(identityNamespace === "tmdb" || identityNamespace === "tvdb" || identityNamespace === "mal") || /^\d+$/.test(identityValue))) {
      const identityColumn = `${identityNamespace}_id`;
      // Un prefijo explícito es una búsqueda de identidad, no de texto. Así
      // `mal:550` nunca devuelve títulos que solo contienen la palabra “mal”.
      likeConditions.splice(0, likeConditions.length);
      likeConditions.unshift(Prisma.sql`${Prisma.raw(`"${identityColumn}"`)} = ${identityNamespace === "tmdb" || identityNamespace === "tvdb" || identityNamespace === "mal" ? Number(identityValue) : identityValue}`);
    }
    if (!identityNamespace && numericTmdbId && Number.isInteger(numericTmdbId) && numericTmdbId > 0) {
      likeConditions.push(Prisma.sql`tmdb_id = ${numericTmdbId}`);
      likeConditions.push(Prisma.sql`tvdb_id = ${numericTmdbId}`);
      likeConditions.push(Prisma.sql`mal_id = ${numericTmdbId}`);
      likeConditions.push(Prisma.sql`anilist_id = ${String(numericTmdbId)}`);
      likeConditions.push(Prisma.sql`anidb_id = ${String(numericTmdbId)}`);
    }
    const explicitIdentitySearch = Boolean(identityNamespace && identityValue && (!(identityNamespace === "tmdb" || identityNamespace === "tvdb" || identityNamespace === "mal") || /^\d+$/.test(identityValue)));
    const orLikeSql = Prisma.join(likeConditions, " OR ");
    const searchCondition = explicitIdentitySearch
      ? Prisma.sql`(${orLikeSql})`
      : Prisma.sql`(search_vector @@ plainto_tsquery('simple', ${tsQuery}) OR ${orLikeSql})`;
    const categoryFilter = category
      ? Prisma.sql`AND LOWER(category) LIKE ${`%${category.toLowerCase()}%`}`
      : Prisma.empty;
    const genreFilter = options.genre?.trim()
      ? Prisma.sql`AND LOWER(genres) LIKE ${`%${options.genre.trim().toLowerCase()}%`}`
      : Prisma.empty;
    const yearFilter = Number.isInteger(options.year) && Number(options.year) > 0
      ? Prisma.sql`AND year = ${Number(options.year)}`
      : Prisma.empty;
    const missingIdentityField = options.identity?.startsWith("missing_") ? options.identity.slice("missing_".length) : null;
    const missingTmdbFilter = options.missingTmdb || options.identity === "missing_tmdb"
      ? Prisma.sql`AND tmdb_id IS NULL`
      : options.identity === "missing_any"
        ? Prisma.sql`AND tmdb_id IS NULL AND imdb_id IS NULL AND tvdb_id IS NULL AND mal_id IS NULL AND anilist_id IS NULL AND kitsu_id IS NULL AND anidb_id IS NULL`
        : missingIdentityField && ["imdb", "mal", "anilist", "kitsu", "anidb", "tvdb"].includes(missingIdentityField)
          ? Prisma.sql`AND ${Prisma.raw(`"${missingIdentityField}_id"`)} IS NULL`
          : Prisma.empty;
    const limitOffset = onlyMainPath || options.dedupe
      ? Prisma.empty
      : Prisma.sql`LIMIT ${pageSize} OFFSET ${skip}`;
    const orderBy = options.sort === "rating"
      ? Prisma.sql`ORDER BY rating DESC NULLS LAST, "created_at" DESC`
      : options.sort === "anio"
        ? Prisma.sql`ORDER BY year DESC NULLS LAST, "created_at" DESC`
        : options.sort === "az"
          ? Prisma.sql`ORDER BY LOWER(title) ASC, "created_at" DESC`
          : Prisma.sql`ORDER BY
              CASE
                WHEN LOWER(title) = LOWER(${tsQuery}) THEN 0
                WHEN LOWER(title) LIKE ${`%${tsQuery}%`} THEN 1
                ${variants[1] ? Prisma.sql`WHEN LOWER(title) LIKE ${`%${variants[1]}%`} THEN 1` : Prisma.empty}
                WHEN LOWER("english_title") = LOWER(${tsQuery}) THEN 2
                WHEN LOWER("english_title") LIKE ${`%${tsQuery}%`} THEN 3
                ELSE 4
              END,
              rank DESC,
              "created_at" DESC`;

    const showsQuery = Prisma.sql`
      SELECT
        "id", "title", "original_title", "japanese_title", "english_title",
        "normalized_title", "base_normalized_title", "tmdb_id", "imdb_id", "tvdb_id", "mal_id", "anilist_id", "kitsu_id", "anidb_id", "description", "poster_url", "banner_url",
        "poster_path", "backdrop_path", "category", "rating", "year",
        "status", "genres", "created_at",
        ts_rank(search_vector, plainto_tsquery('simple', ${tsQuery})) AS rank
      FROM "Show"
      WHERE ${searchCondition}
      ${categoryFilter}
      ${genreFilter}
      ${yearFilter}
      ${missingTmdbFilter}
      ${orderBy}
      ${limitOffset}
    `;

    const countQuery = Prisma.sql`
      SELECT COUNT(*)::int AS total
      FROM "Show"
      WHERE ${searchCondition}
      ${categoryFilter}
      ${genreFilter}
      ${yearFilter}
      ${missingTmdbFilter}
    `;

    if (!onlyMainPath) {
      const [shows, countResult] = await Promise.all([
        prisma.$queryRaw(showsQuery),
        prisma.$queryRaw(countQuery),
      ]);
      if (options.dedupe) {
        const uniqueShows = dedupeCatalogShows(shows as any[]);
        const pagedShows = uniqueShows.slice(skip, skip + pageSize);
        return { shows: pagedShows, total: uniqueShows.length, page: pageNum, pageSize, totalPages: Math.ceil(uniqueShows.length / pageSize) };
      }
      const total = Number((countResult as any[])[0]?.total || 0);
      return { shows, total, page: pageNum, pageSize, totalPages: Math.ceil(total / pageSize) };
    }

    let allShows = await prisma.$queryRaw(showsQuery) as any[];
    const hasLiteralTitleHit = allShows.some((show) => {
      const title = String(show.title || '').toLowerCase();
      const english = String(show.english_title || '').toLowerCase();
      const original = String(show.original_title || '').toLowerCase();
      return title.includes(s.toLowerCase()) || english.includes(s.toLowerCase()) || original.includes(s.toLowerCase());
    });
    if (!explicitIdentitySearch && (!hasLiteralTitleHit || allShows.length === 0) && s.length >= 3) {
      const prefixes = fuzzySearchPrefixes(s);
      if (prefixes.length > 0) {
        let fuzzyShows: any[] = [];
        try {
          const similarityScore = Prisma.sql`GREATEST(
            similarity(LOWER(COALESCE("title", '')), LOWER(${s})),
            similarity(LOWER(COALESCE("english_title", '')), LOWER(${s})),
            similarity(LOWER(COALESCE("original_title", '')), LOWER(${s})),
            similarity(LOWER(COALESCE("japanese_title", '')), LOWER(${s}))
          )`;
          const fuzzyCategory = category
            ? Prisma.sql`AND LOWER(category) LIKE ${`%${category.toLowerCase()}%`}`
            : Prisma.empty;
          const fuzzyGenre = options.genre?.trim()
            ? Prisma.sql`AND LOWER(genres) LIKE ${`%${options.genre.trim().toLowerCase()}%`}`
            : Prisma.empty;
          const fuzzyYear = Number.isInteger(options.year) && Number(options.year) > 0
            ? Prisma.sql`AND year = ${Number(options.year)}`
            : Prisma.empty;
          fuzzyShows = await prisma.$queryRaw(Prisma.sql`
            SELECT
              "id", "title", "original_title", "japanese_title", "english_title",
              "normalized_title", "base_normalized_title", "tmdb_id", "imdb_id", "tvdb_id", "mal_id", "anilist_id", "kitsu_id", "anidb_id", "description", "poster_url", "banner_url",
              "poster_path", "backdrop_path", "category", "rating", "year",
              "status", "genres", "created_at", ${similarityScore} AS rank
            FROM "Show"
            WHERE ${similarityScore} >= ${0.22}
            ${fuzzyCategory}
            ${fuzzyGenre}
            ${fuzzyYear}
            ${missingTmdbFilter}
            ORDER BY rank DESC, "created_at" DESC
            LIMIT 500
          `) as any[];
        } catch {
          const prefixClauses = prefixes.map((prefix) => {
            const pattern = `%${prefix.slice(0, 2)}%`;
            const fields = titleFields.map((field) => Prisma.sql`${field} LIKE ${pattern}`);
            return Prisma.sql`(${Prisma.join(fields, " OR ")})`;
          });
          const fuzzyCategory = category
            ? Prisma.sql`AND LOWER(category) LIKE ${`%${category.toLowerCase()}%`}`
            : Prisma.empty;
          const fuzzyGenre = options.genre?.trim()
            ? Prisma.sql`AND LOWER(genres) LIKE ${`%${options.genre.trim().toLowerCase()}%`}`
            : Prisma.empty;
          const fuzzyYear = Number.isInteger(options.year) && Number(options.year) > 0
            ? Prisma.sql`AND year = ${Number(options.year)}`
            : Prisma.empty;
          fuzzyShows = await prisma.$queryRaw(Prisma.sql`
            SELECT
              "id", "title", "original_title", "japanese_title", "english_title",
              "normalized_title", "base_normalized_title", "tmdb_id", "imdb_id", "tvdb_id", "mal_id", "anilist_id", "kitsu_id", "anidb_id", "description", "poster_url", "banner_url",
              "poster_path", "backdrop_path", "category", "rating", "year",
              "status", "genres", "created_at", 0 AS rank
            FROM "Show"
            WHERE ${Prisma.join(prefixClauses, " AND ")}
            ${fuzzyCategory}
            ${fuzzyGenre}
            ${fuzzyYear}
            ${missingTmdbFilter}
            ORDER BY "created_at" DESC
            LIMIT 500
          `) as any[];
        }
        allShows = [...allShows, ...fuzzyShows];
      }
    }

    const playableShows = await filterShowsToMainPath(allShows as any[]);
    const uniqueShows = dedupeCatalogShows(playableShows);
    const shows = uniqueShows.slice(skip, skip + pageSize);
    const total = uniqueShows.length;
    return { shows, total, page: pageNum, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  let where: any = {};
  if (category) {
    where.category = { contains: category, mode: "insensitive" };
  }
  if (options.genre?.trim()) {
    where.genres = { contains: options.genre.trim(), mode: "insensitive" };
  }
  if (Number.isInteger(options.year) && Number(options.year) > 0) {
    where.year = Number(options.year);
  }
  if (options.missingTmdb || options.identity === "missing_tmdb") where.tmdb_id = null;
  if (options.identity === "missing_any") {
    where = { ...where, tmdb_id: null, imdb_id: null, tvdb_id: null, mal_id: null, anilist_id: null, kitsu_id: null, anidb_id: null };
  }
  const selectedIdentity = options.identity?.startsWith("missing_") ? options.identity.slice("missing_".length) : null;
  if (selectedIdentity && ["imdb", "mal", "anilist", "kitsu", "anidb", "tvdb"].includes(selectedIdentity)) where[`${selectedIdentity}_id`] = null;

  if (!onlyMainPath) {
    // Igual que en la búsqueda: la deduplicación debe ver todas las filas para
    // que el paginado administrativo no repita ni pierda obras.
    const shouldPageInDb = !options.dedupe;
    const orderBy = options.sort === "rating"
      ? [{ rating: "desc" as const }, { created_at: "desc" as const }]
      : options.sort === "anio"
        ? [{ year: "desc" as const }, { created_at: "desc" as const }]
        : options.sort === "az"
          ? [{ title: "asc" as const }, { created_at: "desc" as const }]
          : { created_at: "desc" as const };
    const [shows, total] = await Promise.all([
      prisma.show.findMany({
        where,
        select: {
          id: true,
          title: true,
          normalized_title: true,
          base_normalized_title: true,
          tmdb_id: true,
          imdb_id: true,
          tvdb_id: true,
          mal_id: true,
          anilist_id: true,
          kitsu_id: true,
          anidb_id: true,
          poster_url: true,
          banner_url: true,
          category: true,
          rating: true,
          year: true,
          genres: true,
          created_at: true,
          _count: { select: { episodes: true } },
        },
        orderBy,
        ...(shouldPageInDb ? { skip, take: pageSize } : {}),
      }),
      prisma.show.count({ where }),
    ]);
    if (options.dedupe) {
      const uniqueShows = dedupeCatalogShows(shows as any[]);
      const pagedShows = uniqueShows.slice(skip, skip + pageSize);
      return { shows: pagedShows, total: uniqueShows.length, page: pageNum, pageSize, totalPages: Math.ceil(uniqueShows.length / pageSize) };
    }
    return { shows, total, page: pageNum, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  const allShows = await prisma.show.findMany({
    where,
    select: {
      id: true,
      title: true,
      original_title: true,
      japanese_title: true,
      english_title: true,
      normalized_title: true,
      base_normalized_title: true,
      tmdb_id: true,
      imdb_id: true,
      tvdb_id: true,
      mal_id: true,
      anilist_id: true,
      kitsu_id: true,
      anidb_id: true,
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
    orderBy: options.sort === "rating"
      ? [{ rating: "desc" as const }, { created_at: "desc" as const }]
      : options.sort === "anio"
        ? [{ year: "desc" as const }, { created_at: "desc" as const }]
        : options.sort === "az"
          ? [{ title: "asc" as const }, { created_at: "desc" as const }]
          : { created_at: "desc" as const },
  });
  const playableShows = await filterShowsToMainPath(allShows as any[]);
  // Defense in depth: historical legacy Show rows may contain the same work
  // more than once. Canonical identity is applied before pagination so both
  // the cards and X-Catalog-Count represent unique works.
  const uniqueShows = dedupeCatalogShows(playableShows);
  const shows = uniqueShows.slice(skip, skip + pageSize);
  const total = uniqueShows.length;
  return { shows, total, page: pageNum, pageSize, totalPages: Math.ceil(total / pageSize) };
}

export async function getShowByIdFromDb(id: string) {
  if (!id) return null;
  const direct = await prisma.show.findUnique({
    where: { id },
    include: {
      episodes: {
        orderBy: { episode_number: "asc" },
      },
    },
  });
  if (direct) return direct;

  // Fallback 1: Buscar por TMDB ID si el ID tiene formato "tmdb-xxx-123", "tmdb:123" o es numérico
  const tmdbMatch = id.match(/(?:tmdb(?:-(?:movie|series|anime))?[:\-]?)(\d+)/i) || id.match(/^(\d+)$/);
  const tmdbIdNum = tmdbMatch ? parseInt(tmdbMatch[1], 10) : null;
  if (tmdbIdNum && Number.isInteger(tmdbIdNum) && tmdbIdNum > 0) {
    const byTmdb = await prisma.show.findFirst({
      where: { tmdb_id: tmdbIdNum },
      include: {
        episodes: {
          orderBy: { episode_number: "asc" },
        },
      },
    });
    if (byTmdb) return byTmdb;
  }

  // Fallback 2: Buscar en MediaItem por ID canónico o TMDB ID
  const mediaItem = await prisma.mediaItem.findFirst({
    where: {
      OR: [
        { id },
        ...(tmdbIdNum ? [{ tmdb_id: tmdbIdNum }] : []),
      ],
    },
  });
  if (mediaItem) {
    const byMedia = await prisma.show.findFirst({
      where: {
        OR: [
          ...(mediaItem.tmdb_id ? [{ tmdb_id: mediaItem.tmdb_id }] : []),
          { normalized_title: mediaItem.canonical_title },
        ],
      },
      include: {
        episodes: {
          orderBy: { episode_number: "asc" },
        },
      },
    });
    if (byMedia) return byMedia;
  }

  return null;
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
  mal_id?: number | string | null;
  anilist_id?: string | number | null;
  kitsu_id?: string | number | null;
  anidb_id?: string | number | null;
  imdb_id?: string | null;
  tvdb_id?: number | string | null;
  tmdb_id?: number | string | null;
  main_path_overrides?: unknown;
}

export async function updateShowFields(showId: string, patch: UpdateShowPatch) {
  const existing = await prisma.show.findUnique({ where: { id: showId } });
  if (!existing) return null;

  const data: Record<string, unknown> = {};
  const manualOverrides: Record<string, unknown> = existing.manual_overrides && typeof existing.manual_overrides === "object" && !Array.isArray(existing.manual_overrides)
    ? { ...(existing.manual_overrides as Record<string, unknown>) }
    : {};

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
  if (patch.mal_id !== undefined) {
    const raw = patch.mal_id === null || patch.mal_id === "" ? null : Number(patch.mal_id);
    if (raw !== null && (!Number.isInteger(raw) || raw <= 0)) throw new Error("mal_id debe ser un entero positivo o vacío.");
    if (raw !== null) {
      const conflict = await prisma.show.findFirst({ where: { mal_id: raw, id: { not: showId } }, select: { id: true, title: true } });
      if (conflict) throw new Error(`El MAL ID ${raw} ya está asignado a “${conflict.title}”.`);
    }
    data.mal_id = raw;
  }
  if (patch.tmdb_id !== undefined) {
    const raw = patch.tmdb_id === null || patch.tmdb_id === "" ? null : Number(patch.tmdb_id);
    if (raw !== null && (!Number.isInteger(raw) || raw <= 0)) throw new Error("tmdb_id debe ser un entero positivo o vacío.");
    if (raw !== null && raw !== existing.tmdb_id) {
      const conflict = await prisma.show.findFirst({ where: { tmdb_id: raw, id: { not: showId } }, select: { id: true, title: true } });
      if (conflict) throw new Error(`El TMDB ID ${raw} ya está asignado a “${conflict.title}”. Usa la revisión de identidad para decidir la fusión.`);
    }
    data.tmdb_id = raw;
  }
  for (const key of ["anilist_id", "kitsu_id", "anidb_id", "imdb_id"] as const) {
    if (patch[key] === undefined) continue;
    const raw = patch[key] === null || patch[key] === "" ? null : String(patch[key]).trim().slice(0, 120);
    if (raw && key === "imdb_id" && !/^tt\d{5,12}$/i.test(raw)) throw new Error("imdb_id debe tener el formato tt1234567.");
    if (raw && key === "anidb_id" && !/^\d+$/.test(raw)) throw new Error("anidb_id debe ser numérico.");
    if (raw) {
      const conflict = await prisma.show.findFirst({ where: { [key]: raw, id: { not: showId } } as any, select: { id: true, title: true } });
      if (conflict) throw new Error(`El ${key} ${raw} ya está asignado a “${conflict.title}”.`);
    }
    data[key] = raw || null;
  }
  if (patch.tvdb_id !== undefined) {
    const raw = patch.tvdb_id === null || patch.tvdb_id === "" ? null : Number(patch.tvdb_id);
    if (raw !== null && (!Number.isInteger(raw) || raw <= 0)) throw new Error("tvdb_id debe ser un entero positivo o vacío.");
    if (raw !== null) {
      const conflict = await prisma.show.findFirst({ where: { tvdb_id: raw, id: { not: showId } }, select: { id: true, title: true } });
      if (conflict) throw new Error(`El TVDB ID ${raw} ya está asignado a “${conflict.title}”.`);
    }
    data.tvdb_id = raw;
  }
  if (patch.main_path_overrides !== undefined) {
    const overrides = normalizeShowProviderOverrides(patch.main_path_overrides);
    data.main_path_overrides = overrides;
  }

  // Cada cambio explícito desde el panel queda marcado para que los refrescos
  // automáticos de TMDB solo completen lo que el administrador no fijó.
  const overrideKeys = ["title", "description", "genres", "year", "rating", "status", "category", "poster_url", "banner_url", "japanese_title", "english_title", "mal_id", "anilist_id", "kitsu_id", "anidb_id", "imdb_id", "tvdb_id", "tmdb_id", "main_path_overrides"];
  for (const key of overrideKeys) {
    if (Object.prototype.hasOwnProperty.call(data, key)) manualOverrides[key] = data[key];
  }
  if (Object.keys(manualOverrides).length > 0) data.manual_overrides = manualOverrides;

  if (Object.keys(data).length === 0) {
    return getShowByIdFromDb(showId);
  }

  enqueueShowUpdate(showId, data);

  // La ficha legacy y el índice canónico comparten identidad. Mantener ambos
  // al editar desde administración evita que una búsqueda por MAL/IMDb/etc.
  // vuelva a mostrar datos antiguos en el reproductor multi-fuente.
  const identityFields = ["tmdb_id", "imdb_id", "tvdb_id", "mal_id", "anilist_id", "kitsu_id", "anidb_id"] as const;
  const identityData: Record<string, unknown> = {};
  for (const field of identityFields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) identityData[field] = data[field];
  }
  if (Object.keys(identityData).length > 0) {
    const identityOr = identityFields.flatMap((field) => {
      const value = existing[field];
      return value === null || value === undefined ? [] : [{ [field]: value }];
    });
    const mediaItem = identityOr.length > 0
      ? await prisma.mediaItem.findFirst({ where: { OR: identityOr as any }, orderBy: { created_at: "asc" } })
      : await prisma.mediaItem.findFirst({
          where: { OR: [{ normalized_title: existing.normalized_title }, ...(existing.base_normalized_title ? [{ base_normalized_title: existing.base_normalized_title }] : [])], kind: existing.category },
          orderBy: { created_at: "asc" },
        });
    if (mediaItem) enqueueMediaItemUpdate(mediaItem.id, identityData);
  }
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
  mal_id?: number | null;
  anilist_id?: number | null;
  kitsu_id?: string | null;
  tmdb_id?: number | null;
  /** Temporada detectada en el título/slug de la ficha reescaneada. */
  season?: number | null;
  episodes: Array<{ number: number; title: string; url: string; sources?: SourceLinkInput[] }>;
  source_site?: string;
  /** Locator de una película conocida cuya ficha no expone episodios. */
  fallback_url?: string;
}

export async function quickSyncKnownShow(
  showId: string,
  data: QuickSyncInput
): Promise<{ added: number; sourcesAdded: number }> {
  const show = await prisma.show.findUnique({ where: { id: showId }, include: { episodes: true } });
  if (!show) return { added: 0, sourcesAdded: 0 };

  const kind = (show.category || "anime") as ContentKind;
  let normalizedEpisodes = buildNormalizedEpisodes({
    title: data.title || show.title,
    category: kind,
    source_site: data.source_site,
    episodes: data.episodes,
  }, kind);

  // Cinecalidad y otros catálogos de películas representan la obra como una
  // ficha sin lista de episodios. Aun así necesitamos una MediaEpisode 1x1
  // para guardar el locator de página y resolverlo JIT desde el player.
  if (normalizedEpisodes.length === 0 && data.fallback_url && kind === "movie") {
    normalizedEpisodes = [{
      number: 1,
      title: data.title || show.title,
      url: data.fallback_url,
      sources: [],
    }];
  }

  const showData: any = {
    malId: data.mal_id || null,
    anilistId: data.anilist_id || null,
    kitsuId: data.kitsu_id || null,
    tmdbId: data.tmdb_id || null,
    title: data.title || show.title,
  };

  const season = positiveCatalogNumber(
    data.season ?? parseTitleQuery(data.title || "").season ?? parseTitleQuery(show.title).season,
    1,
  );

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
