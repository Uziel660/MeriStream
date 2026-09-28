/**
 * Cliente mínimo para la aplicación actual de Cinecalidad.
 *
 * Cinecalidad dejó de publicar fichas WordPress con slugs libres. La SPA usa
 * el TMDB id como identidad y genera la ruta desde el título que devuelve su
 * API. Mantener esta lógica en un solo módulo evita volver a construir URLs a
 * partir de títulos almacenados localmente, que es la causa de los enlaces
 * cruzados que quedaron en la base histórica.
 */

export const CINECALIDAD_SITE_URL = "https://www.cinecalidad.am";
export const CINECALIDAD_API_URL = "https://tmdb.allcalidad.re";

export type CinecalidadRouteKind = "movie" | "series" | "anime";
export type CinecalidadApiKind = "movie" | "tvshow" | "anime";

export interface CinecalidadApiItem {
  id?: number;
  tmdb_id?: number;
  kind?: string;
  title: string;
  slug?: string | null;
  overview?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number | null;
  release_date?: string | null;
  first_air_date?: string | null;
  year?: number | null;
  genres?: Array<string | { name?: string }> | null;
  code?: string | null;
  [key: string]: unknown;
}

export interface CinecalidadLookup {
  /** `null` means the API answered 404: the title is not in the current catalog. */
  item: CinecalidadApiItem | null;
  /** Network/5xx failure. Callers should keep a previous locator on this path. */
  failed: boolean;
}

const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 2 * 60 * 1000;
const cache = new Map<string, { expiresAt: number; value: CinecalidadLookup }>();

/** Exact equivalent of the `zS()` function in Cinecalidad's current bundle. */
export function slugifyCinecalidadTitle(title: string): string {
  return String(title || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function toCinecalidadApiKind(kind: string | CinecalidadRouteKind): CinecalidadApiKind {
  const value = String(kind).toLowerCase();
  if (value === "series" || value === "serie" || value === "tv" || value === "tvshow") return "tvshow";
  if (value === "anime") return "anime";
  return "movie";
}

export function toCinecalidadRouteKind(kind: string | CinecalidadApiKind): CinecalidadRouteKind {
  const value = String(kind).toLowerCase();
  if (value === "anime") return "anime";
  if (value === "series" || value === "serie" || value === "tv" || value === "tvshow") return "series";
  return "movie";
}

export function canonicalCinecalidadUrl(item: CinecalidadApiItem): string | null {
  const tmdbId = Number(item.tmdb_id ?? item.id);
  const title = String(item.title || "").trim();
  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !title) return null;
  const kind = toCinecalidadRouteKind(item.kind || "movie");
  const route = kind === "movie" ? "pelicula" : kind === "anime" ? "anime" : "serie";
  const slug = slugifyCinecalidadTitle(title);
  if (!slug) return null;
  return `${CINECALIDAD_SITE_URL}/${route}/${tmdbId}/${slug}`;
}

export function canonicalCinecalidadEpisodeUrl(
  item: CinecalidadApiItem,
  season: number,
  episode: number,
): string | null {
  const tmdbId = Number(item.tmdb_id ?? item.id);
  const s = Number(season);
  const e = Number(episode);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !Number.isInteger(s) || s < 0 || !Number.isInteger(e) || e <= 0) return null;
  const kind = toCinecalidadRouteKind(item.kind || "series");
  if (kind === "movie") return null;
  const route = kind === "anime" ? "anime" : "serie";
  return `${CINECALIDAD_SITE_URL}/${route}/${tmdbId}/temporada/${s}/episodio/${e}`;
}

export interface ParsedCinecalidadLocator {
  kind: CinecalidadRouteKind;
  tmdbId: number;
  slug?: string;
  season?: number;
  episode?: number;
}

/** Parses only the current id-bearing route; legacy `/ver-pelicula/{slug}` is rejected. */
export function parseCinecalidadLocator(rawUrl: string): ParsedCinecalidadLocator | null {
  try {
    const url = new URL(rawUrl);
    if (!/(?:^|\.)cinecalidad\.[a-z]+$/i.test(url.hostname)) return null;
    const episodeMatch = url.pathname.match(/^\/(serie|anime)\/(\d+)\/temporada\/(\d+)\/episodio\/(\d+)\/?$/i);
    if (episodeMatch) {
      const tmdbId = Number(episodeMatch[2]);
      const season = Number(episodeMatch[3]);
      const episode = Number(episodeMatch[4]);
      if (Number.isInteger(tmdbId) && tmdbId > 0 && Number.isInteger(season) && season >= 0 && Number.isInteger(episode) && episode > 0) {
        return { kind: toCinecalidadRouteKind(episodeMatch[1]), tmdbId, season, episode };
      }
      return null;
    }
    const match = url.pathname.match(/^\/(pelicula|serie|anime)\/(\d+)\/([^/?#]+)\/?$/i);
    if (!match) return null;
    const tmdbId = Number(match[2]);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
    return { kind: toCinecalidadRouteKind(match[1]), tmdbId, slug: decodeURIComponent(match[3]) };
  } catch {
    return null;
  }
}

function itemFromPayload(payload: any): CinecalidadApiItem | null {
  const candidate = payload?.item || payload?.data?.item || payload?.data || payload;
  if (!candidate || typeof candidate !== "object") return null;
  const tmdbId = Number(candidate.tmdb_id ?? candidate.id);
  const title = String(candidate.title || "").trim();
  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !title) return null;
  return { ...candidate, tmdb_id: tmdbId, title } as CinecalidadApiItem;
}

async function fetchItem(kind: CinecalidadApiKind, tmdbId: number): Promise<CinecalidadLookup> {
  const key = `${kind}:${tmdbId}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  let value: CinecalidadLookup;
  try {
    const response = await fetch(`${CINECALIDAD_API_URL}/v1/items/${kind}/${tmdbId}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "MeriStream/1.0 (+https://www.merith.me)",
      },
    });
    if (response.status === 404) {
      value = { item: null, failed: false };
    } else if (!response.ok) {
      value = { item: null, failed: true };
    } else {
      const payload = await response.json().catch(() => null);
      const item = itemFromPayload(payload);
      value = item ? { item, failed: false } : { item: null, failed: true };
    }
  } catch {
    value = { item: null, failed: true };
  } finally {
    clearTimeout(timeout);
  }

  cache.set(key, { expiresAt: Date.now() + (value.failed || value.item ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS), value });
  return value;
}

async function fetchEpisode(kind: CinecalidadApiKind, tmdbId: number, season: number, episode: number): Promise<CinecalidadLookup> {
  const key = `${kind}:${tmdbId}:season:${season}:episode:${episode}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  let value: CinecalidadLookup;
  try {
    const response = await fetch(`${CINECALIDAD_API_URL}/v1/items/${kind}/${tmdbId}/seasons/${season}/episodes/${episode}`, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "MeriStream/1.0 (+https://www.merith.me)" },
    });
    if (response.status === 404) value = { item: null, failed: false };
    else if (!response.ok) value = { item: null, failed: true };
    else {
      const payload = await response.json().catch(() => null);
      const candidate = payload?.episode || payload?.data?.episode || payload?.data || payload;
      const episodeItem = candidate && typeof candidate === "object"
        ? itemFromPayload({ ...candidate, tmdb_id: tmdbId, kind })
        : null;
      value = episodeItem ? { item: episodeItem, failed: false } : { item: null, failed: true };
    }
  } catch {
    value = { item: null, failed: true };
  } finally {
    clearTimeout(timeout);
  }
  cache.set(key, { expiresAt: Date.now() + (value.failed || value.item ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS), value });
  return value;
}

export async function lookupCinecalidadItem(kind: string, tmdbId: number): Promise<CinecalidadLookup> {
  const numericId = Number(tmdbId);
  if (!Number.isInteger(numericId) || numericId <= 0) return { item: null, failed: false };
  return fetchItem(toCinecalidadApiKind(kind), numericId);
}

export async function lookupCinecalidadEpisode(
  kind: string,
  tmdbId: number,
  season: number,
  episode: number,
): Promise<CinecalidadLookup> {
  const numericId = Number(tmdbId);
  const numericSeason = Number(season);
  const numericEpisode = Number(episode);
  if (!Number.isInteger(numericId) || numericId <= 0 || !Number.isInteger(numericSeason) || numericSeason < 0 || !Number.isInteger(numericEpisode) || numericEpisode <= 0) {
    return { item: null, failed: false };
  }
  return fetchEpisode(toCinecalidadApiKind(kind), numericId, numericSeason, numericEpisode);
}

export function clearCinecalidadApiCache(): void {
  cache.clear();
}

