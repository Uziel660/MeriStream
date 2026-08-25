// server/showService.ts
import { prisma, normalizeTitle } from "./db";
import { enqueueShowBackfill, showNeedsBackfill } from "./metadataBackfill";
import { enrichUniversalMetadata, cleanQueryTitle, parseTitleQuery } from "./metadataEngine";
import { applyEnrichmentGapFill, isPlausibleYear } from "./metadataMerge";
import { ContentKind } from "./types";
import { getStreamTier } from "./utils/streamSorter";
import { normalizeTitleKey, parseRawTitle, isPlausibleTitle } from "./utils/titleNormalizer";
import { extractStreamFromUrl } from "./universalScraper";
import {
  enqueueWrite,
  enqueueShowCreate,
  enqueueShowUpdate,
  enqueueMediaItemCreate,
  enqueueMediaItemUpdate,
  enqueueEpisodeCreateMany,
} from "./writeBuffer";

export interface SourceLinkInput {
  url: string;
  /** Origen del scrape ("cinecalidad.am", "animeflv.net", ...). Default: "unknown". */
  source_site?: string;
  link_type?: "direct" | "embed";
  host?: string;
  is_verified?: boolean;
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

function buildNormalizedEpisodes(input: SaveShowInput, kind: ContentKind) {
  const inputEpisodes = input.episodes || [];
  const normalizedEpisodes = inputEpisodes
    .filter((ep) => Boolean(ep.url || ep.source_url || input.detected_streams?.[0]))
    .map((ep, idx) => ({
      number: ep.number ?? ep.episode_number ?? idx + 1,
      title: ep.title || (kind === "movie" ? "Película Completa" : `Episodio ${ep.number ?? ep.episode_number ?? idx + 1}`),
      url: ep.url || ep.source_url || input.detected_streams?.[0] || "",
      sources: ep.sources || [],
    }));

  if (normalizedEpisodes.length === 0) {
    const fallbackUrl = input.detected_streams?.[0] || (input as any).source_url || (input as any).url || "";
    if (fallbackUrl) {
      normalizedEpisodes.push({
        number: 1,
        title: kind === "movie" ? "Película Completa" : "Episodio 1",
        url: fallbackUrl,
        sources: [],
      });
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
 * Arquitectura multi-fuente (docs/DB_MULTISOURCE_ARCHITECTURE.md): aglutina N
 * SourceLink bajo un único MediaEpisode deduplicado por obra/temporada/número.
 * 
 * BUFFERIZADO: el upsert del episode se hace directo (necesario para el ID),
 * pero los sourceLinks se encolan en el write buffer para que el drainer los
 * aplique SOLOS, evitando timeouts P1008 en SQLite durante barridos pesados.
 */
export async function syncEpisodeSources(mediaItemId: string, season: number, episodeNumber: number, sources: SourceLinkInput[], defaultSite: string) {
  const cleanSources = (sources || []).filter((s) => s && s.url && typeof s.url === "string");
  if (cleanSources.length === 0) return;

  // Bufferizar TODO: upsert + sourceLinks juntos en el write buffer.
  // El drainer los aplica secuencialmente sin bloquear el worker.
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

  // Temporalmente usamos un placeholder; el drainer resolverá el episode ID real.
  // Por ahora encolamos con mediaItemId como referencia (el drainer busca o crea).
  for (const src of cleanSources) {
    const lower = src.url.toLowerCase();
    const linkType = src.link_type || (/\.(m3u8|mp4|webm|mkv)(\?|#|$)/.test(lower) ? "direct" : "embed");
    enqueueWrite({
      kind: "sourceLink.create",
      data: {
        media_episode_id: mediaItemId, // placeholder: el drainer resuelve el episode correcto
        source_site: src.source_site || defaultSite,
        url: src.url,
        link_type: linkType,
        host: src.host ?? hostOf(src.url),
        priority_tier: getStreamTier(src.url),
        is_verified: src.is_verified ?? false,
        last_checked: new Date().toISOString(),
      },
    });
  }
}

/**
 * Misma clave canónica + año plausible DISTINTO = obra distinta (remakes:
 * "La Bestia" 2012 vs 2026). Un candidato sin año creíble (0/null/garbage)
 * se considera compatible para no duplicar filas legacy cuyo año fue
 * autocompletado con el año corriente.
 */
function pickYearCompatible<T extends { year: number | null }>(candidates: T[], year: number | null): T | null {
  if (candidates.length === 0) return null;
  if (year === null || !isPlausibleYear(year)) return candidates[0];
  const exact = candidates.filter((c) => c.year === year);
  if (exact.length > 0) return exact[0];
  const unknownish = candidates.filter((c) => !isPlausibleYear(c.year ?? null));
  return unknownish[0] ?? null;
}

/**
 * Agrupación multi-temporada/multi-fuente: localiza la obra por su CLAVE
 * CANÓNICA (normalizeTitleKey del título base sin ruido ni temporada), sin
 * importar de qué sitio venga. El año parseado desambigua remakes.
 */
async function findExistingShowByBase(baseNorm: string, year: number | null) {
  if (!baseNorm) return null;
  const candidates = await prisma.show.findMany({
    where: { base_normalized_title: baseNorm },
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

  // C4: consulta indexada por normalized_title en vez de traer los últimos
  // shows completos con episodios y comparar en JS.
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
  console.log(`[Deduplication] Obra existente detectada: '${existingShow.title}' (ID: ${existingShow.id}). Fusionando datos...`);

  const updatePayload: any = {};
  // Upgrade de presentación: si la fila legacy trae ruido ("...Latino HD") y
  // el entrante ya es canónico para la MISMA clave, se adopta el título limpio.
  const existingTitleStr = String(existingShow.title ?? "").trim();
  const incomingTitleStr = String(showData.title ?? "").trim();
  const incomingIsClean = parseRawTitle(incomingTitleStr).canonical === incomingTitleStr;
  if (
    incomingTitleStr &&
    incomingIsClean &&
    parseRawTitle(existingTitleStr).canonical !== existingTitleStr &&
    normalizeTitleKey(existingTitleStr) === normalizeTitleKey(incomingTitleStr)
  ) {
    console.log(`[Deduplication] Título normalizado: '${existingTitleStr}' → '${incomingTitleStr}'`);
    updatePayload.title = incomingTitleStr;
    updatePayload.normalized_title = normalizeTitleKey(incomingTitleStr) || normalizeTitle(incomingTitleStr);
  }
  if (!existingShow.mal_id && showData.malId) updatePayload.mal_id = showData.malId;
  if (!existingShow.anilist_id && showData.anilistId) updatePayload.anilist_id = showData.anilistId;
  if (!existingShow.japanese_title && showData.japaneseTitle) updatePayload.japanese_title = showData.japaneseTitle;
  if (!existingShow.english_title && showData.englishTitle) updatePayload.english_title = showData.englishTitle;
  if ((!existingShow.poster_url || existingShow.poster_url === "") && showData.posterUrl) updatePayload.poster_url = showData.posterUrl;
  if ((!existingShow.banner_url || existingShow.banner_url === "") && showData.bannerUrl) updatePayload.banner_url = showData.bannerUrl;

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
  /** Clave canónica del título completo (normalizeTitleKey). */
  norm: string;
  /** Clave canónica del título base sin temporada (normalizeTitleKey). */
  baseNorm: string;
  /** Año resuelto (caller > TMDB > parseado del título) o null si desconocido. */
  year: number | null;
}

/**
 * Espeja la obra guardada (legacy Show) hacia la arquitectura multi-fuente:
 * MediaItem deduplicado por clave canónica+kind+año, MediaEpisode por
 * temporada/número y SourceLink N-por-episodio. Best-effort: un fallo aquí no
 * rompe el guardado legacy.
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
    if (!norm) return;

    const baseNorm = titleInfo.baseNorm || norm;
    const season = input.season ?? parseTitleQuery(canonical).season ?? 1;
    const enrichedAny = (input as any)._enriched || null;
    const year =
      titleInfo.year !== null && isPlausibleYear(titleInfo.year)
        ? titleInfo.year
        : input.year && isPlausibleYear(input.year)
          ? input.year
          : null;
    // findMany + desambiguación por año en vez de upsert por @@unique: con year
    // NULL, SQL UNIQUE no agrupa nulos entre sí y el selector compuesto de
    // Prisma no acepta null. La clave primaria de agrupación es la CLAVE
    // CANÓNICA del título base (sin sufijo de temporada ni ruido), así
    // "Kaguya-sama TP1"/"TP2" —o "Toy Story 5 Latino HD" y "Toy Story 5"—
    // confluyen en el mismo MediaItem; remakes con año distinto no.
    const orConditions = [
      { base_normalized_title: baseNorm, kind },
      ...(baseNorm !== norm ? [{ normalized_title: norm, kind }] : []),
    ];
    const itemCandidates = await prisma.mediaItem.findMany({
      where: { OR: orConditions },
      orderBy: { created_at: "asc" },
    });
    let mediaItem = pickYearCompatible(itemCandidates, year);
    if (!mediaItem) {
      // Generar ID y encolar (no tocar SQLite)
      const itemId = enqueueMediaItemCreate({
        normalized_title: norm,
        base_normalized_title: baseNorm,
        title: canonical,
        kind,
        year,
        tmdb_id: input.tmdb_id ?? enrichedAny?.tmdb_id ?? null,
        original_title: (enrichedAny?.original_title as string | undefined) || null,
        poster_url: input.poster_url || null,
        poster_path: enrichedAny?.poster_path || null,
        backdrop_path: enrichedAny?.backdrop_path || null,
      });
      // Falso objeto para operaciones posteriores
      mediaItem = { id: itemId, normalized_title: norm, base_normalized_title: baseNorm, title: canonical, kind, year } as any;
    } else {
      const updateData: Record<string, unknown> = {};
      if (!mediaItem.base_normalized_title) updateData.base_normalized_title = baseNorm;
      if (input.poster_url && !mediaItem.poster_url) updateData.poster_url = input.poster_url;
      if (enrichedAny?.tmdb_id && !mediaItem.tmdb_id) updateData.tmdb_id = enrichedAny.tmdb_id;
      if (enrichedAny?.poster_path && !mediaItem.poster_path) updateData.poster_path = enrichedAny.poster_path;
      if (enrichedAny?.backdrop_path && !mediaItem.backdrop_path) updateData.backdrop_path = enrichedAny.backdrop_path;
      if (Object.keys(updateData).length > 0) {
        enqueueMediaItemUpdate(mediaItem.id, updateData);
      }
    }

    const defaultSite = input.source_site || "unknown";

    for (const ep of normalizedEpisodes) {
      const sources = [...ep.sources];
      if (ep.url && !sources.some((s) => s.url === ep.url)) {
        sources.unshift({ url: ep.url });
      }
      await syncEpisodeSources(mediaItem.id, season, ep.number, sources, defaultSite);
    }
  } catch (e) {
    console.error(`[MultiSource] No se pudo sincronizar fuentes para obra legacy ${legacyShowId}:`, e);
  }
}

/**
 * Enriquecimiento diferido: si la obra guardada/fusionada quedó con metadatos
 * faltantes (descripción, póster, géneros...), se encola para completarlos en
 * background con datos REALES del enrichment. NUNCA bloquea ni rompe el guardado.
 */
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

/**
 * MERGE DE SECUELAS POR TMDB: cuando el título difiere pero TMDB confirma que
 * es la MISMA obra (mismo tmdb_id), la secuela se multiplica DENTRO de la obra
 * gemela en vez de crear un cartel separado:
 *   - Episodios legacy → obra gemela con numeración CONTINUA (una sola tarjeta).
 *   - Fuentes multi-fuente → MediaItem gemelo bajo la temporada correspondiente
 *     (detectada en el título; si no hay marca, la siguiente a la máxima existente).
 * Así el "episodio por episodio por plataforma" converge en un solo título.
 */
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

  // Temporada: detectada en el título > siguiente a la máxima ya existente.
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

  // Episodios legacy → gemela, numeración continua (después del último existente).
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

  // Fuentes → MediaItem de la GEMELA (claves de la gemela) bajo la temporada resuelta.
  const twinTitleInfo: CanonicalTitleInfo = {
    canonical: twin.title,
    norm,
    baseNorm: base,
    year: twin.year ?? null,
  };
  await syncMediaItemSources({ ...input, season: seasonNumber } as SaveShowInput, kind, twin.id, normalizedEpisodes, twinTitleInfo);

  // IDs externos que la gemela no tenga.
  const patch: any = {};
  if (!twin.mal_id && showData.malId) patch.mal_id = showData.malId;
  if (!twin.anilist_id && showData.anilistId) patch.anilist_id = showData.anilistId;
  if (Object.keys(patch).length > 0) {
    enqueueShowUpdate(twin.id, patch);
  }

  console.log(
    `[Deduplication] SECUELA fusionada por TMDB ${showData.tmdbId}: "${showData.title}" → "${twin.title}" como temporada ${seasonNumber} (${added} episodios añadidos, numeración continua).`
  );

  const fresh = await prisma.show.findUnique({
    where: { id: twin.id },
    include: { episodes: { orderBy: { episode_number: "asc" } } },
  });
  return { show: fresh!, isDuplicate: true, episodesAdded: added };
}

/**
 * Ensures show passes through AniList / MAL metadata enrichment first,
 * then performs anti-duplication lookup by mal_id and normalized titles,
 * and saves or merges into PostgreSQL.
 */
export async function saveShowWithDeduplication(input: SaveShowInput) {
  // ── Normalización del título crudo del scraper ──────────────────
  // ANTES de guardar y antes de calcular claves de dedup:
  // "Toy Story 5 Latino Español HD" → canonical "Toy Story 5" (+idioma/calidad),
  // "La Bestia 2026 Ver" → "La Bestia" + year 2026.
  const rawParsed = parseRawTitle(String(input.title ?? ""));
  const canonicalTitle = rawParsed.canonical || String(input.title ?? "").trim();
  // parseTitleQuery aporta temporada/año estructural sobre el título YA limpio,
  // así la búsqueda TMDB/Jikan (enrichUniversalMetadata) parte del nombre real.
  const parsed = parseTitleQuery(canonicalTitle);
  const rawTitle = parsed.baseTitle || canonicalTitle;
  const kind: ContentKind = (input.content_type || input.category || "anime") as ContentKind;
  // Temporada explícita del caller > detectada en el título > 1.
  const season = input.season ?? rawParsed.season ?? parsed.season ?? 1;

  // Guard anti-títulos-basura (fugas tipo "pe", "Género: ...", URLs de debug):
  // se rechaza la obra y el pipeline la marca como item fallido sin detener el barrido.
  if (rawParsed.plausible === false || !isPlausibleTitle(canonicalTitle)) {
    throw new Error(`Título implausible descartado por el guard: "${input.title}"`);
  }

  const showData = {
    malId: input.mal_id || null,
    anilistId: input.anilist_id || null,
    tmdbId: input.tmdb_id || null,
    // Título VISIBLE = canónico sin ruido. El crudo del scraper NO se guarda
    // (el schema no tiene columna para conservarlo sin migración).
    title: canonicalTitle,
    originalTitle: input.original_title || null,
    japaneseTitle: input.japanese_title || null,
    englishTitle: input.english_title || null,
    description: input.description || "",
    posterUrl: input.poster_url || null,
    bannerUrl: input.banner_url || null,
    rating: input.rating || 8.0,
    // Defecto #24: un año desconocido se queda en 0 para que el enriquecimiento
    // pueda llenarlo con el año real; solo si nadie lo aporta se usa el actual.
    // Prioridad: year del caller > TMDB > parseado del título ("La Bestia 2026").
    year:
      input.year && isPlausibleYear(input.year)
        ? input.year
        : rawParsed.year && isPlausibleYear(rawParsed.year)
          ? rawParsed.year
          : 0,
    status: input.status || "Finalizado",
    genresStr: Array.isArray(input.genres) ? input.genres.join(", ") : (input.genres || "Multimedia")
  };

  let enriched: any = null;
  try {
    // FULL FAST (worker): el caller pidió saltarse el enrichment inline —
    // guarda YA con los datos del sitio; el backfill worker enriquece después
    // EN PARALELO (TMDB tolera 40-50 rps).
    const skipEnrich = (input as any)._skipEnrichment === true;
    // C1 (worker paralelo): si el caller ya trajo metadata externa del análisis
    // del adapter (tmdb_id o poster_path), la cascada TMDB/AniList/TVMaze ya
    // corrió una vez — no repetirla por cada guardado.
    const preEnriched =
      input.tmdb_id || (input as any).poster_path || (input as any).backdrop_path;
    if (skipEnrich) {
      enriched = null;
    } else if (!preEnriched) {
      // enrichUniversalMetadata re-parsea el título y usa season/year como hints TMDB.
      // Se le pasa el título CANÓNICO: "Toy Story 5 Latino Español HD" buscaba mal;
      // "Toy Story 5" sí resuelve descripción/póster en TMDB.
      enriched = await enrichUniversalMetadata(canonicalTitle, kind);
    } else {
      enriched = {
        tmdb_id: input.tmdb_id ?? undefined,
        original_title: input.original_title ?? undefined,
        poster_path: (input as any).poster_path,
        backdrop_path: (input as any).backdrop_path,
      };
    }
    applyEnrichedMetadata(input, showData, enriched);
    // La metadata TMDB es canónica: título es-MX y rutas de imagen crudas.
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

  // ── Claves canónicas de dedup ───────────────────────────────────
  // normalizeTitleKey elimina ruido/años/puntuación, así el título sucio del
  // scraper y una fila previa limpia producen LA MISMA clave:
  //   "Toy Story 5 Latino Español HD" ≡ "Toy Story 5" → "toystory5".
  const normTitle = normalizeTitleKey(canonicalTitle) || normalizeTitle(canonicalTitle);
  const baseNorm = normalizeTitleKey(rawTitle) || normTitle;
  const normJap = showData.japaneseTitle ? normalizeTitle(showData.japaneseTitle) : "";
  const normEng = showData.englishTitle ? normalizeTitle(showData.englishTitle) : "";

  // El año (caller > TMDB > parseado) desambigua remakes con la misma clave.
  const dedupYear = showData.year > 0 ? showData.year : null;
  const existingShow =
    (await findExistingShowByBase(baseNorm, dedupYear)) ??
    (await findExistingShow(showData.malId ?? showData.tmdbId ? showData.malId : null, normTitle, normEng, normJap));
  const normalizedEpisodes = buildNormalizedEpisodes(input, kind);
  const titleInfo: CanonicalTitleInfo = {
    canonical: canonicalTitle,
    norm: normTitle,
    baseNorm,
    year: dedupYear,
  };

  if (existingShow) {
    const result = await mergeShowEpisodes(existingShow, showData, normalizedEpisodes);
    await syncMediaItemSources(input, kind, result.show.id, normalizedEpisodes, titleInfo);
    enqueueBackfillIfIncomplete(result.show);
    return { ...result, season };
  }

  // ── MERGE DE SECUELAS POR TMDB ──
  // Título distinto pero MISMA obra según TMDB (mismo tmdb_id): es una secuela/
  // temporada sin marca en el nombre. Se multiplexa dentro de la gemela.
  if (showData.tmdbId) {
    const twin = await prisma.show.findFirst({
      where: { tmdb_id: showData.tmdbId, base_normalized_title: { not: baseNorm } },
      orderBy: { created_at: "asc" },
    });
    if (twin) {
      const result = await mergeSequelIntoTwin(twin, showData, normalizedEpisodes, input, kind, season);
      enqueueBackfillIfIncomplete(result.show);
      return { ...result, season: result.show ? season : season };
    }
  }

  console.log(`[Deduplication] Nueva obra verificada sin duplicados. Encolando en buffer RAM...`);

  // Generar ID y encolar show.create + episodios (NUNCA toco SQLite directamente)
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
    year: showData.year > 0 ? showData.year : new Date().getFullYear(),
    status: showData.status,
    genres: showData.genresStr,
  });

  // Encolar episodios
  enqueueEpisodeCreateMany(
    showId,
    normalizedEpisodes.map((ep) => ({
      show_id: showId,
      episode_number: ep.number,
      title: ep.title,
      source_url: ep.url,
    }))
  );

  // Falso objeto show para las operaciones posteriores (el real se crea en el writer)
  const createdShow = {
    id: showId,
    title: showData.title,
    normalized_title: normTitle,
    base_normalized_title: baseNorm,
    category: kind,
    year: showData.year > 0 ? showData.year : new Date().getFullYear(),
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

  await syncMediaItemSources(input, kind, createdShow.id, normalizedEpisodes, titleInfo);
  enqueueBackfillIfIncomplete(createdShow);

  return {
    show: createdShow as any,
    isDuplicate: false,
    episodesAdded: normalizedEpisodes.length,
    season,
  };
}

/**
 * Returns all shows from PostgreSQL with optional search/category filter
 */
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

/**
 * Lite mode: shows WITHOUT episodes. ~2MB vs ~15MB.
 * Used by frontend for local-filtered catalog and admin panel.
 * Supports pagination: ?page=1&limit=100
 * Uses PostgreSQL full-text search (tsvector + GIN) when search is provided.
 */
export async function getShowsFromDbLite(
  search?: string,
  category?: string,
  page?: number,
  limit?: number
) {
  const pageNum = Math.max(1, page || 1);
  const pageSize = Math.min(50000, Math.max(1, limit || 500));
  const skip = (pageNum - 1) * pageSize;

  // PostgreSQL full-text search via raw query (much faster than LIKE)
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

  // Fallback: sin búsqueda, solo categoría o todo
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
 * Clear all shows from database — TODO de verdad: además del esquema legacy
 * (Show/Episode) se vacían los MediaItem (y en cascada MediaEpisode/SourceLink)
 * para que "vaciar catálogo" no deje huérfanos invisibles.
 */
export async function clearAllShowsFromDb() {
  await prisma.episode.deleteMany({});
  await prisma.show.deleteMany({});
  await prisma.mediaItem.deleteMany({});
}

// ═══════════════ Editor de catálogo (panel de administración) ═══════════════

/** Campos editables de una obra vía PUT /api/v1/shows/:show_id. */
export interface UpdateShowPatch {
  title?: string;
  description?: string;
  /** Acepta array (se une con ", ") o string directo. */
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

/**
 * Actualiza SOLO los campos presentes en el patch: jamás rellena los defaults
 * falsos del schema (rating 8.0, genres "Multimedia", status "Finalizado").
 * Si cambia `title`, recalcula normalized_title y base_normalized_title con el
 * MISMO pipeline de saveShowWithDeduplication (parseRawTitle → parseTitleQuery
 * → normalizeTitleKey) para mantener la consistencia de la dedup.
 * Devuelve la obra actualizada (con episodios) o null si no existe.
 */
export async function updateShowFields(showId: string, patch: UpdateShowPatch) {
  const existing = await prisma.show.findUnique({ where: { id: showId } });
  if (!existing) return null;

  const data: Record<string, unknown> = {};

  if (typeof patch.title === "string") {
    const raw = patch.title.replace(/\s+/g, " ").trim();
    if (raw) {
      // Réplica exacta del cálculo de claves canónicas del guardado:
      //   "Toy Story 5 Latino HD" → canonical "Toy Story 5" → "toystory5".
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
    const joined = Array.isArray(patch.genres) ? patch.genres.join(", ") : String(patch.genres);
    if (joined.trim()) data.genres = joined;
  }
  if (typeof patch.year === "number" && Number.isFinite(patch.year)) data.year = Math.round(patch.year);
  if (typeof patch.rating === "number" && Number.isFinite(patch.rating)) data.rating = patch.rating;
  if (typeof patch.status === "string" && patch.status.trim()) data.status = patch.status.trim();
  if (typeof patch.category === "string" && patch.category.trim()) data.category = patch.category.trim();
  // Los nullable admiten null explícito para LIMPIAR el campo (acción deliberada
  // del editor; no confundir con defaults falsos autocompletados).
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

/** Página de episodio (".../ver/slug-1") disfrazada de stream: el player nativo muere. */
function looksLikeSourcePage(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return /\/(ver|watch|episode|ep|capitulo)\//.test(pathname) && !/\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(url);
  } catch {
    return false;
  }
}

function isDirectMediaUrl(url: string): boolean {
  return /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(url);
}

/** Sitio de origen de una URL (hostname sin www) para etiquetar SourceLinks. */
function siteOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Re-resuelve en JIT los servidores de cada Episode con source_url (mismo motor
 * que POST /api/v1/catalog/episode-servers: extractStreamFromUrl) y sincroniza
 * hacia el MediaItem espejo de la obra vía syncEpisodeSources. Si la obra no
 * tiene MediaItem espejo, se omite silenciosamente. Pensado para correr en
 * background: nunca lanza, devuelve un resumen contable.
 */
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

  // Misma localización del MediaItem espejo que syncMediaItemSources: clave
  // canónica (base_normalized_title/normalized_title + kind), año como desambiguador.
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
  // Sin MediaItem espejo no hay dónde escribir SourceLinks: omitir silenciosamente.
  if (!mediaItem) return summary;

  for (const ep of targetEpisodes) {
    try {
      const extracted = await extractStreamFromUrl(ep.source_url);
      const all = Array.from(
        new Set([extracted.stream_url, ...(extracted.all_available_streams || [])].filter(Boolean))
      ) as string[];
      // Mismo guard anti-pseudo-streams del endpoint episode-servers: la página
      // origen NO cuenta como resolución; la media directa sí aunque coincida.
      const realStreams = all.filter(
        (u) => (u !== ep.source_url || isDirectMediaUrl(u)) && !looksLikeSourcePage(u)
      );
      if (realStreams.length === 0) {
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
      summary.sources_added += realStreams.filter((u) => !knownUrls.has(u)).length;

      await syncEpisodeSources(
        mediaItem.id,
        season,
        ep.episode_number,
        realStreams.map((url) => ({ url, source_site: episodeSite })),
        "unknown"
      );
    } catch (e) {
      summary.episodes_without_streams++;
      console.error(`[RefreshStreams] No se pudo resolver '${ep.source_url}' (obra '${show.title}'):`, e);
    }
  }

  return summary;
}

// ── ÍNDICE DE RE-ESCANEO ─────────────────────────────────────────────
// Verificación LIGERA de una obra ya conocida: inserta solo los episodios
// que falten (comparando la lista de la ficha contra la BD) y sincroniza
// sus fuentes al MediaItem. SIN TMDB, SIN enrichment, SIN re-guardado.
// Los streams de los episodios nuevos se resuelven Just-In-Time al reproducir.

export interface QuickSyncInput {
  title?: string;
  episodes: Array<{ number: number; title: string; url: string }>;
  source_site?: string;
}

export async function quickSyncKnownShow(
  showId: string,
  data: QuickSyncInput
): Promise<{ added: number }> {
  const show = await prisma.show.findUnique({ where: { id: showId }, include: { episodes: true } });
  if (!show) return { added: 0 };

  const normalizedEpisodes = (data.episodes || [])
    .filter((e) => Number.isFinite(e.number) || e.url)
    .map((e) => ({
      number: Number(e.number) || 0,
      title: e.title || `Episodio ${e.number}`,
      url: e.url || "",
      sources: [] as SourceLinkInput[],
    }));

  const showData: any = {
    malId: null,
    anilistId: null,
    title: data.title || show.title,
  };

  const result = await mergeShowEpisodes(show, showData, normalizedEpisodes);

  const kind = (show.category || "anime") as ContentKind;
  const titleInfo: CanonicalTitleInfo = {
    canonical: show.title,
    norm: show.normalized_title,
    baseNorm: show.base_normalized_title || show.normalized_title,
    year: show.year ?? null,
  };
  await syncMediaItemSources(
    { title: show.title, source_site: data.source_site } as SaveShowInput,
    kind,
    show.id,
    normalizedEpisodes,
    titleInfo
  );

  return { added: result.episodesAdded };
}
