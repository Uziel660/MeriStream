// server/metadataBackfill.ts
// ══════════════════════════════════════════════════════════════════
// ENRIQUECIMIENTO DIFERIDO: completa metadatos FALTANTES de obras ya
// guardadas usando la cascada real de enriquecimiento (TMDB/AniList/
// TVMaze vía enrichUniversalMetadata).
//
// Reglas de oro (del dueño del proyecto):
//  - JAMÁS toca la lógica de dedup/merge (showService) ni claves canónicas.
//  - SOLO escribe en campos vacíos/nulos, y SOLO con datos REALES del
//    enrichment. Los defaults falsos del pipeline (rating 8.0, status
//    "Finalizado", genres "Multimedia") NO son datos y nunca se escriben.
//  - Paralelismo alto con limitador global de TMDB (35 req/s por proceso).
//    El número de obras/s depende de cuántos campos necesite cada obra.
// ══════════════════════════════════════════════════════════════════

import { prisma, normalizeTitle, normalizeBaseTitle } from "./db";
import type { Show, MediaItem, Prisma } from "@prisma/client";
import { enqueueWrite } from "./writeBuffer";
import { enrichUniversalMetadata, isLikelyNonSpanishDescription } from "./metadataEngine";
import { endsWithTruncationEllipsis } from "./metadataMerge";
import { normalizeTitleKey, parseRawTitle, isPlausibleTitle, isSlugLikeTitle, cleanSlugToWords } from "./utils/titleNormalizer";
import { formatAndNormalizeGenres } from "./utils/genreNormalizer";
import { cleanDescription, isAnomalousDescription } from "./utils/textCleaner";
import type { ContentKind } from "./types";

interface BackfillResult {
  showId: string;
  title: string;
  changed: string[];
  at: string;
}

const state = {
  queue: [] as string[],
  queued: new Set<string>(),
  // Evita que llamadas consecutivas al endpoint vuelvan a seleccionar las
  // mismas obras antiguas antes de que cambien sus campos en la BD. Se
  // reinicia al arrancar el proceso, de modo que una nueva ejecución puede
  // reevaluar obras que hayan quedado sin resolver.
  attempted: new Set<string>(),
  processed: 0,
  failed: 0,
  activeWorkers: 0,
  recent: [] as BackfillResult[],
  timer: null as ReturnType<typeof setInterval> | null,
};

export function isLandscapePosterUrl(url?: string | null): boolean {
  if (!url) return false;
  const u = url.toLowerCase();
  return (
    u.includes("w454_and_h254") ||
    u.includes("w500_and_h282") ||
    u.includes("w1280_and_h720") ||
    u.includes("backdrop") ||
    u.includes("fanart") ||
    u.includes("banner") ||
    u.includes("/still/") ||
    u.includes("still_path") ||
    u.includes("horizontal") ||
    u.includes("_landscape") ||
    u.includes("cover_land")
  );
}

export function isLowQualityImage(url?: string | null): boolean {
  if (!url) return true;
  const u = url.toLowerCase();
  return (
    u.length < 15 ||
    u.startsWith("data:") ||
    u.includes("placeholder") ||
    u.includes("default_poster") ||
    u.includes("no-image") ||
    u.includes("noposter") ||
    u.includes("no_poster") ||
    u.includes("nopic") ||
    u.includes("no-cover") ||
    // Some imports contain a TMDB title wordmark as a PNG (for example a
    // 177x21 transparent logo). Prefer the canonical poster_path during the
    // normal metadata backfill instead of persisting that art as a poster.
    (u.includes("image.tmdb.org/t/p/") && /\.(?:png|svg)(?:[?#]|$)/i.test(u)) ||
    u.includes("blank.png") ||
    u.includes("dummyimage") ||
    u.includes("veranimes.net") ||
    u.includes("images.unsplash.com") ||
    u.includes("/w92/") ||
    u.includes("/w154/") ||
    u.includes("/w185/") ||
    u.includes("thumb_small") ||
    u.includes("_preview") ||
    u.includes("mini_") ||
    u.includes("100x") ||
    u.includes("150x")
  );
}

/** true si a la obra le faltan metadatos o tiene portadas/sinopsis de baja calidad que valga la pena corregir. */
export function showNeedsBackfill(show: {
  title?: string | null;
  description?: string | null;
  poster_url?: string | null;
  banner_url?: string | null;
  genres?: string | null;
  year?: number | null;
  tmdb_id?: number | null;
}): boolean {
  // Título con ruido estructural ("... Latino HD", "Ver X online") o slug pegado ("sixjoursceprintempsla")
  if (show.title) {
    if (isSlugLikeTitle(show.title)) return true;
    const parsed = parseRawTitle(show.title);
    if (parsed.canonical !== show.title && isPlausibleTitle(parsed.canonical)) return true;
  }
  // Descripción anómala (HTML entities como &nbsp;, mojibake, marcas de scrapers)
  if (isAnomalousDescription(show.description, show.title)) {
    return true;
  }
  // El catálogo histórico contiene sinopsis en inglés aunque no estén vacías;
  // volver a enriquecerlas permite guardarlas en español sin perder el TMDB.
  if (isLikelyNonSpanishDescription(show.description)) {
    return true;
  }
  // Portada horizontal en lugar de poster vertical, o imagen de baja calidad/placeholder
  if (isLandscapePosterUrl(show.poster_url) || isLowQualityImage(show.poster_url) || isLowQualityImage(show.banner_url) || show.banner_url === show.poster_url) {
    return true;
  }
  // Géneros sin formato o pegados ("accion aventura", "Multimedia", sin comas)
  if (show.genres) {
    const rawG = show.genres.trim();
    if (rawG === "Multimedia" || (!rawG.includes(",") && rawG.includes(" ")) || rawG.toLowerCase() === rawG) {
      return true;
    }
  }
  return (
    !show.description ||
    show.description.trim() === "" ||
    !show.poster_url ||
    !show.banner_url ||
    !show.genres ||
    show.genres.trim() === "" ||
    show.genres === "Multimedia" ||
    !show.year ||
    show.year <= 0 ||
    !show.tmdb_id
  );
}

/** Encola una obra (idempotente). La procesa el pool paralelo con límite TMDB. */
export function enqueueShowBackfill(showId: string): void {
  if (!showId || state.queued.has(showId)) return;
  state.queued.add(showId);
  state.queue.push(showId);
  startWorker();
}

const BACKFILL_POOL = 20; // Workers simultáneos; metadataEngine limita TMDB a 35 req/s.
function startWorker(): void {
  if (state.timer) return;
  // POOL PARALELO: hasta 20 backfills simultáneos (antes era serial). El
  // limitador de metadataEngine evita exceder el techo de TMDB.
  state.timer = setInterval(() => {
    if (state.queue.length === 0 && state.activeWorkers === 0) {
      if (state.timer) clearInterval(state.timer);
      state.timer = null;
      return;
    }
    while (state.activeWorkers < BACKFILL_POOL && state.queue.length > 0) {
      const showId = state.queue.shift();
      if (!showId) break;
      state.queued.delete(showId);
      state.activeWorkers++;
      backfillShow(showId)
        .then((r) => {
          state.processed++;
          if (r.changed.length > 0) {
            state.recent.unshift(r);
            state.recent = state.recent.slice(0, 20);
          }
        })
        .catch(() => {
          state.failed++;
        })
        .finally(() => {
          state.activeWorkers--;
        });
    }
  }, 100);
}

/** Placeholder típico de scrapers/TMDB vacío: nunca debe guardarse como dato. */
function isPlaceholderDescription(text: unknown): boolean {
  const t = String(text || "").trim();
  if (t.length < 40) return true;
  return /sin descripci|no descrip|añade un resumen|no hemos añadido|contenido indexado|obra multimedia indexada|just-in-time/i.test(t);
}

/**
 * Completa SOLO los campos vacíos de una obra con datos reales del enrichment.
 * Nunca escribe sobre valores existentes ni defaults falsos.
 */
export async function backfillShow(showId: string): Promise<BackfillResult> {
  const show = await prisma.show.findUnique({ where: { id: showId } });
  if (!show) {
    return { showId, title: "(eliminada)", changed: [], at: new Date().toISOString() };
  }

  const result: BackfillResult = {
    showId,
    title: show.title,
    changed: [],
    at: new Date().toISOString(),
  };

  const data: Record<string, unknown> = {};

  // ── Reparación de título (NO requiere enrichment) ──
  // Ruido estructural del scraper ("X Latino Español HD", "Ver X online") o slug pegado
  // ("temporadaparamatar" -> "Temporada Para Matar") para buscar en TMDB con precisión.
  if (show.title) {
    if (isSlugLikeTitle(show.title)) {
      data.title = cleanSlugToWords(show.title);
    } else {
      const parsed = parseRawTitle(show.title);
      if (parsed.canonical !== show.title && isPlausibleTitle(parsed.canonical)) {
        data.title = parsed.canonical;
      }
    }
  }

  const kind = (show.category || "anime") as ContentKind;
  let enriched: any = null;
  const searchTitle = String(data.title || show.title || "").trim();
  try {
    enriched = await enrichUniversalMetadata(searchTitle, kind);
  } catch {
    enriched = null;
  }

  // Limpieza directa de la descripción actual si contiene anomalías (&nbsp;, mojibake, título duplicado)
  const currentTitle = String(data.title ?? show.title ?? "");
  const currentDesc = (show.description || "").trim();
  const cleanedCurrentDesc = cleanDescription(currentDesc, currentTitle);
  if (cleanedCurrentDesc && cleanedCurrentDesc !== currentDesc) {
    data.description = cleanedCurrentDesc;
  }

  // Sin enrichment igual se aplica la reparación de título y descripción (flush temprano).
  if (!enriched) {
    if (Object.keys(data).length > 0) {
      await prisma.show.update({ where: { id: showId }, data });
      result.changed = Object.keys(data);
      result.title = String(data.title ?? show.title);
    }
    return result;
  }
  if (!showNeedsBackfill(show) && Object.keys(data).length === 0) return result;

  const currentDescTruncated = endsWithTruncationEllipsis(currentDesc);
  const rawEnrichedDesc = enriched.description ? cleanDescription(String(enriched.description), currentTitle) : "";
  const enrichedDescOk =
    !isPlaceholderDescription(rawEnrichedDesc) &&
    !endsWithTruncationEllipsis(rawEnrichedDesc);

  if ((!currentDesc || isPlaceholderDescription(currentDesc)) && enrichedDescOk) {
    data.description = rawEnrichedDesc;
  } else if (
    // Reparación de truncados o anomalías severas
    currentDesc !== "" &&
    (currentDescTruncated || isAnomalousDescription(currentDesc, currentTitle) || isLikelyNonSpanishDescription(currentDesc)) &&
    enrichedDescOk &&
    (isLikelyNonSpanishDescription(currentDesc) || rawEnrichedDesc.length > currentDesc.length)
  ) {
    data.description = rawEnrichedDesc;
  }
  // Sustituir poster si falta, si es horizontal (portada/backdrop) o de baja calidad
  if ((!show.poster_url || isLowQualityImage(show.poster_url) || isLandscapePosterUrl(show.poster_url)) && enriched.poster_path) {
    data.poster_url = `https://image.tmdb.org/t/p/w780${enriched.poster_path}`;
    data.poster_path = enriched.poster_path;
  } else if ((!show.poster_url || isLowQualityImage(show.poster_url) || isLandscapePosterUrl(show.poster_url)) && enriched.poster_url && !isLandscapePosterUrl(enriched.poster_url)) {
    data.poster_url = enriched.poster_url;
  }

  // Sustituir banner si falta, si es idéntico al poster vertical o si es de baja calidad
  if ((!show.banner_url || show.banner_url === show.poster_url || isLowQualityImage(show.banner_url)) && enriched.backdrop_path) {
    data.banner_url = `https://image.tmdb.org/t/p/w1280${enriched.backdrop_path}`;
    data.backdrop_path = enriched.backdrop_path;
  } else if ((!show.banner_url || show.banner_url === show.poster_url || isLowQualityImage(show.banner_url)) && enriched.banner_url) {
    data.banner_url = enriched.banner_url;
  }
  // Reparar título si es un slug pegado ("sixjoursceprintempsla")
  if (isSlugLikeTitle(show.title)) {
    if (enriched.title && !isSlugLikeTitle(enriched.title)) {
      data.title = enriched.title;
      data.normalized_title = normalizeTitleKey(enriched.title);
      data.base_normalized_title = normalizeTitleKey(enriched.title);
    } else {
      const cleanWords = cleanSlugToWords(show.title);
      data.title = cleanWords;
      data.normalized_title = normalizeTitleKey(cleanWords);
      data.base_normalized_title = normalizeTitleKey(cleanWords);
    }
  }

  // Normalizar y formatear géneros con comas y acentos estándar
  const currentGenres = show.genres || "";
  const normalizedGenres = formatAndNormalizeGenres(currentGenres, enriched.genres);
  if (normalizedGenres && normalizedGenres !== currentGenres && normalizedGenres !== "Multimedia") {
    data.genres = normalizedGenres;
  }
  if ((!show.year || show.year <= 0) && Number.isFinite(enriched.year) && enriched.year > 0) {
    data.year = enriched.year;
  }
  if (!show.tmdb_id && enriched.tmdb_id) {
    data.tmdb_id = enriched.tmdb_id;
  }

  if (Object.keys(data).length > 0) {
    try {
      await prisma.show.update({ where: { id: showId }, data });
    } catch (e) {
      // BD lenta/bloqueada (p.ej. barrido pesado a la vez): OUTBOX — la
      // escritura va a archivo y el drainer la aplica solo cuando responda.
      enqueueWrite({ kind: "show.update", id: showId, data });
      console.warn(`[Backfill] Escritura diferida en write-buffer para obra ${showId}: ${e?.message || e}`);
    }
    result.changed = Object.keys(data);
    if (data.title) {
      result.title = String(data.title);
    }
    // Espejo multi-fuente: identidad y título visibles en el MediaItem
    // (best-effort). El ID debe propagarse aun cuando el título ya estuviera
    // completo en el Show.
    if (Object.keys(data).length > 0) {
      try {
        const base = show.base_normalized_title || show.normalized_title;
        const mediaKinds = kind === "anime" || kind === "series"
          ? { in: ["anime", "series"] }
          : kind;
        let item = data.tmdb_id
          ? await prisma.mediaItem.findFirst({
              // TMDB comparte namespace entre anime y series; solo las
              // películas/documentales permanecen en un namespace separado.
              where: { tmdb_id: data.tmdb_id, kind: mediaKinds },
              orderBy: { created_at: "asc" },
            })
          : null;
        if (!item) {
          item = await prisma.mediaItem.findFirst({
            where: {
              OR: [
                { base_normalized_title: base, kind: mediaKinds },
                ...(show.normalized_title !== base ? [{ normalized_title: show.normalized_title, kind: mediaKinds }] : []),
              ],
            },
          });
        }
        if (item) {
          const itemData: Record<string, unknown> = {};
          if (data.title && item.title !== data.title) itemData.title = String(data.title);
          if (data.tmdb_id && !item.tmdb_id) itemData.tmdb_id = data.tmdb_id;
          // Propagar el arte TMDB al índice multi-fuente cuando la imagen
          // anterior era un thumbnail, placeholder o portada del proveedor.
          if (data.poster_url && isLowQualityImage(item.poster_url)) itemData.poster_url = data.poster_url;
          if (data.poster_path && (!item.poster_path || isLowQualityImage(item.poster_url))) itemData.poster_path = data.poster_path;
          if (data.backdrop_path && !item.backdrop_path) itemData.backdrop_path = data.backdrop_path;
          if (Object.keys(itemData).length > 0) {
            await prisma.mediaItem.update({ where: { id: item.id }, data: itemData });
          }
        }
      } catch {
        /* best-effort */
      }
    }
  }
  return result;
}

/**
 * Barrido manual: encola hasta `limit` obras con metadatos faltantes
 * (las más antiguas primero). No bloquea: el worker las procesa en background.
 */
export async function backfillMissingMetadata(limit: number = 100): Promise<{ queued: number }> {
  const nonSpanishMarkers = [
    " the ", " and ", " this ", " with ", " from ", " their ", " about ", " when ",
    " after ", " story ", " returns ", " follows ", " young ", " must ", " will ",
    " into ", " during ", " through ", " where ", " which ", " first ", " life ",
    " world ", " series ", " film ", " movie ",
  ];
  const attemptedIds = Array.from(state.attempted);
  const shows = await prisma.show.findMany({
    where: {
      ...(attemptedIds.length > 0 ? { id: { notIn: attemptedIds } } : {}),
      OR: [
        { description: "" },
        // Sinopsis truncadas por el sitio fuente: candidatas a reparación.
        { description: { endsWith: "..." } },
        { description: { endsWith: "…" } },
        { poster_url: null },
        { banner_url: null },
        { genres: "Multimedia" },
        { year: { lte: 0 } },
        { tmdb_id: null },
        ...nonSpanishMarkers.map((marker) => ({
          description: { contains: marker, mode: "insensitive" as const },
        })),
      ],
    },
    orderBy: { created_at: "asc" },
    take: Math.min(Math.max(1, Math.round(limit) || 100), 2000),
    select: { id: true },
  });
  for (const s of shows) {
    state.attempted.add(s.id);
    enqueueShowBackfill(s.id);
  }
  return { queued: shows.length };
}

export function getBackfillStatus(): {
  pending: number;
  processed: number;
  failed: number;
  activeWorkers: number;
  recent: BackfillResult[];
} {
  return {
    pending: state.queue.length,
    processed: state.processed,
    failed: state.failed,
    activeWorkers: state.activeWorkers,
  };
}

export interface ForceShowMetadataInput {
  query?: string;
  tmdb_id?: number;
  imdb_id?: string;
  kind?: string;
  apply_mode?: "full" | "identity_only";
}

export interface TmdbCanonicalRecord {
  id: number;
  media_type: "movie" | "tv";
  title: string;
  original_title: string | null;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  year: number | null;
  rating: number;
  genres: string[];
  imdb_id: string | null;
  tvdb_id: number | null;
}

export type ForceShowMetadataResult = Show & {
  show: Show;
  media_item_synced: boolean;
};

async function fetchExactTmdbRecord(params: {
  tmdbId?: number | null;
  imdbId?: string | null;
  preferredKind?: ContentKind;
}): Promise<TmdbCanonicalRecord | null> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;

  let targetTmdbId = params.tmdbId ? Number(params.tmdbId) : null;
  let mediaType: "movie" | "tv" | null = null;
  let initialData: any = null;

  if (params.imdbId && !targetTmdbId) {
    const cleanImdb = params.imdbId.trim().toLowerCase();
    try {
      const findUrl = `https://api.themoviedb.org/3/find/${encodeURIComponent(cleanImdb)}?external_source=imdb_id&language=es-MX&api_key=${encodeURIComponent(apiKey)}`;
      const findRes = await fetch(findUrl, { headers: { Accept: "application/json" } });
      if (findRes.ok) {
        const findJson = await findRes.json();
        const movieResults = Array.isArray(findJson.movie_results) ? findJson.movie_results : [];
        const tvResults = Array.isArray(findJson.tv_results) ? findJson.tv_results : [];

        if (params.preferredKind === "movie" && movieResults.length > 0) {
          targetTmdbId = movieResults[0].id;
          mediaType = "movie";
          initialData = movieResults[0];
        } else if ((params.preferredKind === "series" || params.preferredKind === "anime") && tvResults.length > 0) {
          targetTmdbId = tvResults[0].id;
          mediaType = "tv";
          initialData = tvResults[0];
        } else if (movieResults.length > 0) {
          targetTmdbId = movieResults[0].id;
          mediaType = "movie";
          initialData = movieResults[0];
        } else if (tvResults.length > 0) {
          targetTmdbId = tvResults[0].id;
          mediaType = "tv";
          initialData = tvResults[0];
        }
      }
    } catch {
      // ignore network fetch error
    }
  }

  if (!targetTmdbId) return null;

  const candidateTypes: Array<"movie" | "tv"> = mediaType
    ? [mediaType]
    : params.preferredKind === "series"
      ? ["tv", "movie"]
      : ["movie", "tv"];

  let detail: any = null;
  let resolvedMediaType: "movie" | "tv" = candidateTypes[0];

  for (const type of candidateTypes) {
    try {
      const detailUrl = `https://api.themoviedb.org/3/${type}/${targetTmdbId}?append_to_response=external_ids&language=es-MX&api_key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(detailUrl, { headers: { Accept: "application/json" } });
      if (res.ok) {
        detail = await res.json();
        resolvedMediaType = type;
        break;
      }
    } catch {
      // ignore probe error
    }
  }

  if (!detail) {
    if (initialData) {
      detail = initialData;
      resolvedMediaType = mediaType || "movie";
    } else {
      return null;
    }
  }

  const title = String(detail.title || detail.name || "").trim();
  const originalTitle = detail.original_title || detail.original_name || null;
  const overview = typeof detail.overview === "string" ? detail.overview.trim() : "";
  const posterPath = detail.poster_path || null;
  const backdropPath = detail.backdrop_path || null;

  const rawDate = detail.release_date || detail.first_air_date || "";
  const year = rawDate ? Number.parseInt(String(rawDate).slice(0, 4), 10) : null;
  const rating = detail.vote_average ? Math.round(Number(detail.vote_average) * 10) / 10 : 8.0;

  const genreNames: string[] = Array.isArray(detail.genres)
    ? detail.genres.map((g: any) => g?.name).filter(Boolean)
    : [];

  const extIds = detail.external_ids || {};
  let imdbId = extIds.imdb_id || detail.imdb_id || params.imdbId || null;
  if (typeof imdbId === "string") {
    imdbId = imdbId.trim().toLowerCase();
    if (!/^tt\d{5,12}$/.test(imdbId)) imdbId = null;
  }
  const tvdbId = Number.isInteger(extIds.tvdb_id) && extIds.tvdb_id > 0 ? extIds.tvdb_id : null;

  return {
    id: targetTmdbId,
    media_type: resolvedMediaType,
    title,
    original_title: originalTitle,
    overview,
    poster_path: posterPath,
    backdrop_path: backdropPath,
    year: Number.isFinite(year) && year! > 0 ? year : null,
    rating,
    genres: genreNames,
    imdb_id: imdbId,
    tvdb_id: tvdbId,
  };
}

export async function syncMediaItemForShow(
  show: Show,
  options?: { applyMode?: "full" | "identity_only" },
): Promise<MediaItem | null> {
  const kind = show.category || "movie";
  const mediaKindCondition = kind === "anime" || kind === "series" ? { in: ["anime", "series"] } : kind;
  const norm = show.normalized_title || normalizeTitle(show.title);
  const baseNorm = show.base_normalized_title || normalizeBaseTitle(show.title) || norm;
  const year = show.year && show.year > 0 ? show.year : null;
  const tmdbId = show.tmdb_id ?? null;
  const imdbId = show.imdb_id ?? null;

  // 1. Search existing MediaItem
  let mediaItem = tmdbId
    ? await prisma.mediaItem.findFirst({
        where: { tmdb_id: tmdbId, kind: mediaKindCondition },
        orderBy: { created_at: "asc" },
      })
    : null;

  if (!mediaItem && imdbId) {
    mediaItem = await prisma.mediaItem.findFirst({
      where: { imdb_id: imdbId, kind: mediaKindCondition },
      orderBy: { created_at: "asc" },
    });
  }

  if (!mediaItem) {
    mediaItem = await prisma.mediaItem.findFirst({
      where: { normalized_title: norm, kind, year },
      orderBy: { created_at: "asc" },
    });
  }

  if (!mediaItem) {
    const candidates = await prisma.mediaItem.findMany({
      where: {
        kind: mediaKindCondition,
        OR: [
          { normalized_title: norm },
          { base_normalized_title: baseNorm },
        ],
      },
      orderBy: { created_at: "asc" },
    });
    mediaItem = candidates.find((c) => c.year === year) || candidates[0] || null;
  }

  // 2. Create if not found (with P2002 race fallback)
  if (!mediaItem) {
    const createPayload: Prisma.MediaItemCreateInput = {
      normalized_title: norm,
      base_normalized_title: baseNorm,
      title: show.title,
      original_title: show.original_title,
      description: show.description,
      rating: show.rating,
      genres: show.genres,
      tmdb_id: tmdbId,
      imdb_id: imdbId,
      tvdb_id: show.tvdb_id,
      mal_id: show.mal_id,
      anilist_id: show.anilist_id,
      kitsu_id: show.kitsu_id,
      anidb_id: show.anidb_id,
      kind,
      year,
      poster_url: show.poster_url,
      poster_path: show.poster_path,
      backdrop_path: show.backdrop_path,
    };

    try {
      mediaItem = await prisma.mediaItem.create({ data: createPayload });
    } catch (e: any) {
      if (e?.code === "P2002") {
        mediaItem = await prisma.mediaItem.findFirst({
          where: { normalized_title: norm, kind, year },
          orderBy: { created_at: "asc" },
        });
        if (mediaItem) {
          const updatePayload: Record<string, unknown> = {};
          if (tmdbId && mediaItem.tmdb_id !== tmdbId) updatePayload.tmdb_id = tmdbId;
          if (imdbId && mediaItem.imdb_id !== imdbId) updatePayload.imdb_id = imdbId;
          if (show.tvdb_id && mediaItem.tvdb_id !== show.tvdb_id) updatePayload.tvdb_id = show.tvdb_id;
          if (Object.keys(updatePayload).length > 0) {
            mediaItem = await prisma.mediaItem.update({
              where: { id: mediaItem.id },
              data: updatePayload,
            });
          }
        }
      } else {
        console.warn(`[syncMediaItemForShow] Error al crear MediaItem para ${show.id}:`, e);
      }
    }
    return mediaItem;
  }

  // 3. Update existing MediaItem
  if (options?.applyMode === "identity_only") {
    const updateData: Record<string, unknown> = {};
    if (tmdbId && mediaItem.tmdb_id !== tmdbId) updateData.tmdb_id = tmdbId;
    if (imdbId && mediaItem.imdb_id !== imdbId) updateData.imdb_id = imdbId;
    if (show.tvdb_id && mediaItem.tvdb_id !== show.tvdb_id) updateData.tvdb_id = show.tvdb_id;
    if (Object.keys(updateData).length > 0) {
      mediaItem = await prisma.mediaItem.update({
        where: { id: mediaItem.id },
        data: updateData,
      });
    }
    return mediaItem;
  }

  // Full mode update
  const updateData: Record<string, unknown> = {
    title: show.title,
    original_title: show.original_title || mediaItem.original_title,
    description: show.description || mediaItem.description,
    rating: show.rating,
    genres: show.genres,
    tmdb_id: tmdbId ?? mediaItem.tmdb_id,
    imdb_id: imdbId ?? mediaItem.imdb_id,
    tvdb_id: show.tvdb_id ?? mediaItem.tvdb_id,
    base_normalized_title: baseNorm,
  };
  if (show.poster_url) updateData.poster_url = show.poster_url;
  if (show.poster_path) updateData.poster_path = show.poster_path;
  if (show.backdrop_path) updateData.backdrop_path = show.backdrop_path;

  const keyChanged = mediaItem.normalized_title !== norm || mediaItem.year !== year;
  if (keyChanged) {
    const conflict = await prisma.mediaItem.findFirst({
      where: {
        id: { not: mediaItem.id },
        normalized_title: norm,
        kind: mediaItem.kind,
        year,
      },
    });
    if (!conflict) {
      updateData.normalized_title = norm;
      updateData.year = year;
    } else {
      await prisma.mediaItem.update({
        where: { id: conflict.id },
        data: {
          tmdb_id: tmdbId ?? conflict.tmdb_id,
          imdb_id: imdbId ?? conflict.imdb_id,
          tvdb_id: show.tvdb_id ?? conflict.tvdb_id,
        },
      }).catch(() => {});
    }
  }

  try {
    mediaItem = await prisma.mediaItem.update({
      where: { id: mediaItem.id },
      data: updateData,
    });
  } catch (e: any) {
    if (e?.code === "P2002") {
      delete updateData.normalized_title;
      delete updateData.year;
      mediaItem = await prisma.mediaItem.update({
        where: { id: mediaItem.id },
        data: updateData,
      });
    } else {
      console.warn(`[syncMediaItemForShow] Error al actualizar MediaItem ${mediaItem.id}:`, e);
    }
  }

  return mediaItem;
}

export async function forceShowMetadata(
  showId: string,
  inputOrTitle: string | ForceShowMetadataInput,
): Promise<ForceShowMetadataResult> {
  const show = await prisma.show.findUnique({ where: { id: showId } });
  if (!show) throw new Error("Serie no encontrada");

  const input: ForceShowMetadataInput = typeof inputOrTitle === "string"
    ? { query: inputOrTitle }
    : (inputOrTitle || {});

  const applyMode = input.apply_mode === "identity_only" ? "identity_only" : "full";
  let targetTmdbId = input.tmdb_id ? Number(input.tmdb_id) : null;
  let targetImdbId = input.imdb_id ? String(input.imdb_id).trim() : null;
  let query = typeof input.query === "string" ? input.query.trim() : "";

  // Auto-detect ID from query if IDs were omitted
  if (!targetTmdbId && !targetImdbId && query) {
    if (/^tt\d{5,12}$/i.test(query)) {
      targetImdbId = query.toLowerCase();
    } else if (/^\d{1,10}$/.test(query)) {
      targetTmdbId = parseInt(query, 10);
    }
  }

  const kind = (input.kind || show.category || "anime") as ContentKind;
  let canonicalRecord: TmdbCanonicalRecord | null = null;

  // 1. Exact ID lookup if tmdb_id or imdb_id is available
  if (targetTmdbId || targetImdbId) {
    canonicalRecord = await fetchExactTmdbRecord({
      tmdbId: targetTmdbId,
      imdbId: targetImdbId,
      preferredKind: kind,
    });
  }

  // 2. Query search fallback
  if (!canonicalRecord) {
    const searchQuery = query || show.title;
    const enriched = await enrichUniversalMetadata(searchQuery, kind);
    if (enriched) {
      // If enriched has tmdb_id, try fetching external IDs to get imdb_id
      if (enriched.tmdb_id) {
        canonicalRecord = await fetchExactTmdbRecord({
          tmdbId: enriched.tmdb_id,
          preferredKind: kind,
        });
      }
      if (!canonicalRecord) {
        canonicalRecord = {
          id: enriched.tmdb_id || 0,
          media_type: enriched.content_type === "movie" ? "movie" : "tv",
          title: enriched.title,
          original_title: enriched.original_title || null,
          overview: enriched.description || "",
          poster_path: enriched.poster_path || null,
          backdrop_path: enriched.backdrop_path || null,
          year: enriched.year > 0 ? enriched.year : null,
          rating: enriched.rating || 8.0,
          genres: enriched.genres || [],
          imdb_id: (enriched as any).imdb_id || targetImdbId || null,
          tvdb_id: (enriched as any).tvdb_id || null,
        };
      }
    }
  }

  if (!canonicalRecord) {
    throw new Error("No se encontraron metadatos en TMDB para este identificador o título");
  }

  // 3. Prepare atomic update for Show
  const showData: Prisma.ShowUpdateInput = {};

  if (applyMode === "identity_only") {
    if (canonicalRecord.id > 0) showData.tmdb_id = canonicalRecord.id;
    if (canonicalRecord.imdb_id) showData.imdb_id = canonicalRecord.imdb_id;
    if (canonicalRecord.tvdb_id) showData.tvdb_id = canonicalRecord.tvdb_id;
  } else {
    const title = canonicalRecord.title || query || show.title;
    showData.title = title;
    if (canonicalRecord.original_title) showData.original_title = canonicalRecord.original_title;
    showData.normalized_title = normalizeTitle(title);
    showData.base_normalized_title = normalizeBaseTitle(title) || normalizeTitle(title);

    if (canonicalRecord.overview) {
      showData.description = cleanDescription(canonicalRecord.overview, title);
    }
    if (canonicalRecord.poster_path) {
      showData.poster_path = canonicalRecord.poster_path;
      showData.poster_url = `https://image.tmdb.org/t/p/w780${canonicalRecord.poster_path}`;
    }
    if (canonicalRecord.backdrop_path) {
      showData.backdrop_path = canonicalRecord.backdrop_path;
      showData.banner_url = `https://image.tmdb.org/t/p/w1280${canonicalRecord.backdrop_path}`;
    }
    if (canonicalRecord.genres && canonicalRecord.genres.length > 0) {
      showData.genres = canonicalRecord.genres.join(", ");
    }
    if (canonicalRecord.year && canonicalRecord.year > 0) {
      showData.year = canonicalRecord.year;
    }
    if (canonicalRecord.rating && canonicalRecord.rating > 0) {
      showData.rating = canonicalRecord.rating;
    }
    if (canonicalRecord.id > 0) showData.tmdb_id = canonicalRecord.id;
    if (canonicalRecord.imdb_id) showData.imdb_id = canonicalRecord.imdb_id;
    if (canonicalRecord.tvdb_id) showData.tvdb_id = canonicalRecord.tvdb_id;

    if (input.kind) {
      showData.category = input.kind;
    } else if (canonicalRecord.media_type === "tv" && show.category === "movie") {
      showData.category = "series";
    }
  }

  const updatedShow = await prisma.show.update({
    where: { id: showId },
    data: showData,
  });

  // 4. Synchronize with MediaItem (P2002-proof)
  const mediaItem = await syncMediaItemForShow(updatedShow, { applyMode });

  // 5. Construct dual-compatible return object
  const result = Object.assign(updatedShow, {
    show: updatedShow,
    media_item_synced: Boolean(mediaItem),
  });

  return result;
}
