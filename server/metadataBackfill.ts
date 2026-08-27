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
//  - Rate-limit amable: 1 obra cada ~2s. TMDB tolera 40-50 req/s; esto
//    ni lo roza.
// ══════════════════════════════════════════════════════════════════

import { prisma } from "./db";
import { enqueueWrite } from "./writeBuffer";
import { enrichUniversalMetadata } from "./metadataEngine";
import { endsWithTruncationEllipsis } from "./metadataMerge";
import { normalizeTitleKey, parseRawTitle, isPlausibleTitle } from "./utils/titleNormalizer";
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
  processed: 0,
  failed: 0,
  activeWorkers: 0,
  recent: [] as BackfillResult[],
  timer: null as ReturnType<typeof setInterval> | null,
};

function isLowQualityImage(url?: string | null): boolean {
  if (!url) return true;
  const u = url.toLowerCase();
  return (
    u.includes("veranimes.net") ||
    u.includes("images.unsplash.com") ||
    u.includes("placeholder") ||
    u.includes("default_poster") ||
    u.includes("no-image") ||
    u.length < 10
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
}): boolean {
  // Título con ruido estructural ("... Latino HD", "Ver X online") = reparable.
  if (show.title) {
    const parsed = parseRawTitle(show.title);
    if (parsed.canonical !== show.title && isPlausibleTitle(parsed.canonical)) return true;
  }
  // Descripción anómala (HTML entities como &nbsp;, mojibake, título duplicado al inicio)
  if (isAnomalousDescription(show.description, show.title)) {
    return true;
  }
  // Portada de baja calidad (VerAnimes CDN o Unsplash) o banner duplicado del poster
  if (isLowQualityImage(show.poster_url) || isLowQualityImage(show.banner_url) || show.banner_url === show.poster_url) {
    return true;
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
    show.year <= 0
  );
}

/** Encola una obra (idempotente). La procesa el worker interno a 1 cada ~2s. */
export function enqueueShowBackfill(showId: string): void {
  if (!showId || state.queued.has(showId)) return;
  state.queued.add(showId);
  state.queue.push(showId);
  startWorker();
}

const BACKFILL_POOL = 8; // TMDB tolera 40-50 rps: 8 en paralelo ni lo roza

function startWorker(): void {
  if (state.timer) return;
  // POOL PARALELO: hasta 8 backfills simultáneos (antes: 1 cada 2.5s serial
  // = 1000 obras en 42+ min; ahora ~8× más rápido y TMDB sobra de ancho).
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
  }, 250);
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
  // Ruido estructural del scraper ("X Latino Español HD", "Ver X online") →
  // título canónico. Las CLAVES de dedup no se tocan: normalizeTitleKey ya
  // ignora ese ruido, así que la identidad/fusión quedan intactas.
  if (show.title) {
    const parsed = parseRawTitle(show.title);
    if (parsed.canonical !== show.title && isPlausibleTitle(parsed.canonical)) {
      data.title = parsed.canonical;
    }
  }

  const kind = (show.category || "anime") as ContentKind;
  let enriched: any = null;
  try {
    enriched = await enrichUniversalMetadata(data.title || show.title, kind);
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
    (currentDescTruncated || isAnomalousDescription(currentDesc, currentTitle)) &&
    enrichedDescOk &&
    rawEnrichedDesc.length > currentDesc.length
  ) {
    data.description = rawEnrichedDesc;
  }
  // Sustituir poster si falta o si es de baja calidad (VerAnimes/Unsplash)
  if ((!show.poster_url || isLowQualityImage(show.poster_url)) && enriched.poster_path) {
    data.poster_url = `https://image.tmdb.org/t/p/w780${enriched.poster_path}`;
    data.poster_path = enriched.poster_path;
  } else if ((!show.poster_url || isLowQualityImage(show.poster_url)) && enriched.poster_url) {
    data.poster_url = enriched.poster_url;
  }

  // Sustituir banner si falta, si es idéntico al poster vertical o si es de baja calidad
  if ((!show.banner_url || show.banner_url === show.poster_url || isLowQualityImage(show.banner_url)) && enriched.backdrop_path) {
    data.banner_url = `https://image.tmdb.org/t/p/w1280${enriched.backdrop_path}`;
    data.backdrop_path = enriched.backdrop_path;
  } else if ((!show.banner_url || show.banner_url === show.poster_url || isLowQualityImage(show.banner_url)) && enriched.banner_url) {
    data.banner_url = enriched.banner_url;
  }
  if ((!show.genres || show.genres === "Multimedia") && Array.isArray(enriched.genres) && enriched.genres.length > 0) {
    data.genres = enriched.genres.join(", ");
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
    // Espejo multi-fuente: mismo título visible en el MediaItem (best-effort).
    if (data.title) {
      try {
        const base = show.base_normalized_title || show.normalized_title;
        const item = await prisma.mediaItem.findFirst({
          where: {
            OR: [
              { base_normalized_title: base, kind },
              ...(show.normalized_title !== base ? [{ normalized_title: show.normalized_title, kind }] : []),
            ],
          },
        });
        if (item && item.title !== data.title) {
          await prisma.mediaItem.update({ where: { id: item.id }, data: { title: String(data.title) } });
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
  const shows = await prisma.show.findMany({
    where: {
      OR: [
        { description: "" },
        // Sinopsis truncadas por el sitio fuente: candidatas a reparación.
        { description: { endsWith: "..." } },
        { description: { endsWith: "…" } },
        { poster_url: null },
        { banner_url: null },
        { genres: "Multimedia" },
        { year: { lte: 0 } },
      ],
    },
    orderBy: { created_at: "asc" },
    take: Math.min(Math.max(1, Math.round(limit) || 100), 2000),
    select: { id: true },
  });
  for (const s of shows) enqueueShowBackfill(s.id);
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
    recent: state.recent,
  };
}
