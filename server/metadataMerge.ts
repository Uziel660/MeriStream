// server/metadataMerge.ts
// Fusión scraper-first entre los metadatos que trajo el análisis del scraper y los
// del enriquecedor externo (AniList/MAL/TMDB/TVMaze/Wikipedia).
//
// Defectos #10/#13/#16: el enriquecimiento hacía fuzzy-match
// por título y SOBREESCRIBÍA título/sinopsis/poster/año correctos del scraper.
//
// Regla: el scraper MANDA salvo cuando su título es un slug o texto corrupto
// pegado (ej. "sixjoursceprintempsla"), en cuyo caso se adopta el título limpio de TMDB.
// Los géneros se normalizan siempre con formato canónico separado por comas ("Acción, Aventura").

import { isSlugLikeTitle, cleanSlugToWords } from "./utils/titleNormalizer";
import { formatAndNormalizeGenres } from "./utils/genreNormalizer";

/** Descripciones placeholder generadas por el propio pipeline (nunca son datos reales). */
const PLACEHOLDER_DESCRIPTIONS: RegExp[] = [
  /^contenido indexado en voidstream/i,
  /^sin descripción disponible\.?$/i,
  /^obra multimedia indexada\.?$/i,
  /^no se pudo cargar la página\.?$/i,
];

/** Poster/banner genérico de Unsplash usado por el fallback del enriquecedor. */
const PLACEHOLDER_IMAGE_HOSTS: RegExp[] = [/images\.unsplash\.com/i];

export interface ScraperMetadataInput {
  title: string;
  description?: string;
  poster_url?: string | null;
  banner_url?: string | null;
  rating?: number;
  year?: number;
  status?: string;
  genres?: string | string[];
}

export interface MergeableMetadataTarget {
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
}

interface EnrichedLike {
  mal_id?: number | null;
  anilist_id?: number | null;
  title?: string;
  japanese_title?: string | null;
  english_title?: string | null;
  description?: string;
  poster_url?: string | null;
  banner_url?: string | null;
  rating?: number;
  year?: number;
  status?: string;
  genres?: string[];
}

/**
 * Cola de elipsis de truncado ("...", "…"): los sitios fuente cortan la sinopsis
 * a N caracteres y rematan con puntos suspensivos.
 */
const TRAILING_ELLIPSIS_RE = /(?:\.{3,}|…)\s*$/;
const ELLIPSIS_ABBREV_RE =
  /(?:\b(?:etc|etc[eé]tera|vs|sr|sra|srta|dr|dra|ing|lic|av|apdo|ed|vol|n[uú]m|inc|ltd|ee\.?\s?uu|usa)\b\.?|(?:\b[a-z]\.){1,3}[a-z]\.?)$/i;

/** true si el texto termina en elipsis de truncado (no en una abreviatura legítima). */
export function endsWithTruncationEllipsis(value?: string | null): boolean {
  const t = String(value ?? "").replace(/\s+/g, " ").trimEnd();
  const m = t.match(TRAILING_ELLIPSIS_RE);
  if (!m || m.index === undefined) return false;
  return !ELLIPSIS_ABBREV_RE.test(t.slice(0, m.index).trimEnd());
}

/** Texto suficientemente sustantivo y no placeholder. */
export function hasSubstantiveText(value?: string | null): boolean {
  const t = (value || "").trim();
  if (t.length < 12) return false;
  if (endsWithTruncationEllipsis(t)) return false;
  return !PLACEHOLDER_DESCRIPTIONS.some((p) => p.test(t));
}

/** Imagen presente y no-placeholder. */
export function isUsableImage(value?: string | null): boolean {
  const t = (value || "").trim();
  if (!t) return false;
  return !PLACEHOLDER_IMAGE_HOSTS.some((p) => p.test(t));
}

/** Año dentro de un rango creíble (descarta el "año corriente" por defecto). */
export function isPlausibleYear(year?: number | null): boolean {
  return (
    typeof year === "number" &&
    Number.isFinite(year) &&
    year >= 1900 &&
    year <= new Date().getFullYear()
  );
}

/**
 * Fusiona el enriquecimiento sobre los datos del scraper:
 * - Si el título del scraper es un slug o texto pegado (ej. "sixjoursceprintempsla"), adopta el título limpio de TMDB;
 * - sinopsis/poster/año/etc. del enriquecedor solo llenan campos vacíos o placeholder;
 * - géneros siempre se normalizan con acentos y comas estándar ("Acción, Aventura").
 */
export function applyEnrichmentGapFill(
  input: ScraperMetadataInput,
  target: MergeableMetadataTarget,
  enriched: EnrichedLike | null | undefined
): void {
  if (!enriched) {
    target.genresStr = formatAndNormalizeGenres(input.genres || target.genresStr, null);
    if (isSlugLikeTitle(target.title)) {
      target.title = cleanSlugToWords(target.title);
    }
    return;
  }

  // IDs externos: siempre valiosos para deduplicación, solo si faltan
  if (!target.malId && enriched.mal_id) target.malId = enriched.mal_id;
  if (!target.anilistId && enriched.anilist_id) target.anilistId = enriched.anilist_id;

  // Títulos alternativos: completan, nunca sustituyen al título del scraper
  if (!target.japaneseTitle && enriched.japanese_title) {
    target.japaneseTitle = enriched.japanese_title;
  }
  if (!target.englishTitle && enriched.english_title) {
    target.englishTitle = enriched.english_title;
  }

  // Título: Si el scraper trajo un slug corrupto o sin espacios (ej: "sixjoursceprintempsla")
  if (isSlugLikeTitle(target.title)) {
    if (enriched.title && !isSlugLikeTitle(enriched.title)) {
      target.title = enriched.title;
    } else {
      target.title = cleanSlugToWords(target.title);
    }
  }

  // Sinopsis: solo si el scraper no trajo una propia sustantiva
  if (!hasSubstantiveText(input.description) && hasSubstantiveText(enriched.description)) {
    target.description = enriched.description;
  }

  // Imágenes: ignorar placeholders (Unsplash) del enriquecedor
  if (!isUsableImage(target.posterUrl) && isUsableImage(enriched.poster_url)) {
    target.posterUrl = enriched.poster_url as string;
    if (!isUsableImage(target.bannerUrl) && isUsableImage(enriched.banner_url)) {
      target.bannerUrl = enriched.banner_url as string;
    }
  } else if (!isUsableImage(target.bannerUrl) && isUsableImage(enriched.banner_url)) {
    target.bannerUrl = enriched.banner_url as string;
  }

  // Campos numéricos/textuales: el valor del scraper gana; enriquecer solo huecos
  if (!input.rating && enriched.rating) target.rating = enriched.rating;
  if (!isPlausibleYear(input.year) && isPlausibleYear(enriched.year)) {
    target.year = enriched.year as number;
  }
  if (!input.status && enriched.status) target.status = enriched.status;

  // Géneros: normalización canónica separada por comas con acentos
  target.genresStr = formatAndNormalizeGenres(input.genres || target.genresStr, enriched.genres);
}
