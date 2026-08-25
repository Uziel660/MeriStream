// server/siteRatingService.ts
//
// Servicio de calificación de sitios fuente (modelo SiteRating en Prisma).
// Los ratings ordenan la cascada de sitios en los endpoints /play (F4): a igual
// calidad de stream, se prefiere el sitio con mejor rating.
// Caché en memoria (Map + TTL 60s) para no golpear SQLite en cada comparación.

import { prisma } from "./db";

const CACHE_TTL_MS = 60_000;
const DEFAULT_RATING = 5;

interface CacheEntry {
  rating: number;
  enabled: boolean;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * "www.cinecalidad.am" → "cinecalidad"; "TioAnime.HD" → "tioanime".
 * Primer token antes de punto, lowercase, sin prefijo www.
 */
export function siteFromDomain(host: string): string {
  const h = String(host || "")
    .toLowerCase()
    .trim();
  if (!h) return "";
  const withoutWww = h.replace(/^www\./, "");
  return withoutWww.split(".")[0] || "";
}

function normalizeSite(site: string): string {
  // Acepta dominio completo ("www.cinecalidad.am") o nombre ya normalizado.
  return site.includes(".") ? siteFromDomain(site) : site.toLowerCase().trim();
}

/** Rating del sitio (0-10). Default DEFAULT_RATING si no existe o está disabled. */
export async function getSiteRating(site: string): Promise<number> {
  const key = normalizeSite(site);
  if (!key) return DEFAULT_RATING;

  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.enabled ? hit.rating : DEFAULT_RATING;
  }

  try {
    const row = await prisma.siteRating.findUnique({ where: { site: key } });
    if (row) {
      cache.set(key, {
        rating: row.rating,
        enabled: row.enabled,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return row.enabled ? row.rating : DEFAULT_RATING;
    }
    cache.set(key, { rating: DEFAULT_RATING, enabled: true, expiresAt: Date.now() + CACHE_TTL_MS });
    return DEFAULT_RATING;
  } catch {
    // DB caída → degradar a default sin romper el endpoint
    return DEFAULT_RATING;
  }
}

export interface SiteRatingInfo {
  site: string;
  rating: number;
  enabled: boolean;
  notes: string | null;
}

/** Lista completa de ratings (sin caché; uso admin/debug). */
export async function getAllSiteRatings(): Promise<SiteRatingInfo[]> {
  const rows = await prisma.siteRating.findMany({ orderBy: [{ rating: "desc" }, { site: "asc" }] });
  return rows.map((r) => ({ site: r.site, rating: r.rating, enabled: r.enabled, notes: r.notes }));
}

export async function upsertSiteRating(
  site: string,
  rating?: number,
  enabled?: boolean,
  notes?: string | null
): Promise<SiteRatingInfo> {
  const key = normalizeSite(site);
  if (!key) throw new Error("site requerido");

  const data: { rating?: number; enabled?: boolean; notes?: string | null } = {};
  if (typeof rating === "number" && Number.isFinite(rating)) {
    data.rating = Math.max(0, Math.min(10, rating));
  }
  if (typeof enabled === "boolean") data.enabled = enabled;
  if (notes !== undefined) data.notes = notes;

  const row = await prisma.siteRating.upsert({
    where: { site: key },
    update: data,
    create: { site: key, rating: data.rating ?? DEFAULT_RATING, enabled: data.enabled ?? true, notes: data.notes ?? null },
  });

  cache.delete(key);
  return { site: row.site, rating: row.rating, enabled: row.enabled, notes: row.notes };
}

/**
 * Comparador async para sort de sitios por rating descendente.
 * Empate (o error DB) → 0, conservando el orden original (sort estable).
 */
export async function compareSitesByRatingDesc(a: string, b: string): Promise<number> {
  try {
    const [ra, rb] = await Promise.all([getSiteRating(a), getSiteRating(b)]);
    return rb - ra;
  } catch {
    return 0;
  }
}
