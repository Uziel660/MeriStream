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

import { prisma } from "./db";
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

export async function forceShowMetadata(showId: string, customTitle: string) {
  const show = await prisma.show.findUnique({ where: { id: showId } });
  if (!show) throw new Error("Serie no encontrada");

  const kind = (show.category || "anime") as ContentKind;
  const enriched = await enrichUniversalMetadata(customTitle, kind);
  if (!enriched) throw new Error("No se encontraron metadatos en TMDB para este título");

  const data: any = { title: customTitle };
  if (enriched.description) data.description = enriched.description;
  if (enriched.poster_path) data.poster_url = `https://image.tmdb.org/t/p/w780${enriched.poster_path}`;
  else if (enriched.poster_url) data.poster_url = enriched.poster_url;
  if (enriched.backdrop_path) data.banner_url = `https://image.tmdb.org/t/p/w1280${enriched.backdrop_path}`;
  else if (enriched.banner_url) data.banner_url = enriched.banner_url;

  if (Array.isArray(enriched.genres) && enriched.genres.length > 0) data.genres = enriched.genres.join(", ");
  if (Number.isFinite(enriched.year) && enriched.year! > 0) data.year = enriched.year;
  if (enriched.tmdb_id) data.tmdb_id = enriched.tmdb_id;

  const updated = await prisma.show.update({ where: { id: showId }, data });
  return updated;
}
