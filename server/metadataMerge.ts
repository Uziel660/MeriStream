// server/metadataMerge.ts
// Fusión scraper-first entre los metadatos que trajo el análisis del scraper y los
// del enriquecedor externo (AniList/MAL/TMDB/TVMaze/Wikipedia).
//
// Defectos #10/#13/#16 (informe E2E 2026-08-23): el enriquecimiento hacía fuzzy-match
// por título y SOBREESCRIBÍA título/sinopsis/poster/año correctos del scraper
// (ej. Frieren Latino guardado como "Kidou Shinseiki Gundam X"), o pisaba datos
// reales de la ficha con placeholders genéricos ("Contenido indexado en
// VoidStream...", poster de Unsplash, año corriente).
//
// Regla: el scraper MANDA; el enriquecedor solo completa huecos y jamás introduce
// valores placeholder.

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
 * a N caracteres y rematan con puntos suspensivos. Excepciones legítimas donde
 * la elipsis NO implica corte: abreviaturas tipo "etc...", "vs...", "Sr...",
 * "EE.UU..." o iniciales punteadas ("J.R.R...").
 */
const TRAILING_ELLIPSIS_RE = /(?:\.{3,}|…)\s*$/;
const ELLIPSIS_ABBREV_RE =
  /(?:\b(?:etc|etc[eé]tera|vs|sr|sra|srta|dr|dra|ing|lic|av|apdo|ed|vol|n[uú]m|inc|ltd|ee\.?\s?uu|usa)\b\.?|(?:\b[a-z]\.){1,3}[a-z]\.?)$/i;

/** true si el texto termina en elipsis de truncado (no en una abreviatura legítima). */
export function endsWithTruncationEllipsis(value?: string | null): boolean {
  const t = String(value ?? "").replace(/\s+/g, " ").trimEnd();
  const m = t.match(TRAILING_ELLIPSIS_RE);
  if (!m || m.index === undefined) return false;
  // "etc…", "vs..." y similares son finales válidos, no sinopsis cortadas.
  return !ELLIPSIS_ABBREV_RE.test(t.slice(0, m.index).trimEnd());
}

/** Texto suficientemente sustantivo y no placeholder. */
export function hasSubstantiveText(value?: string | null): boolean {
  const t = (value || "").trim();
  if (t.length < 12) return false;
  // Una sinopsis que termina en "..." está CORTADA: se considera débil para que
  // la descripción completa del enriquecedor (TMDB/AniList) pueda reemplazarla.
  // Si ninguna fuente trae algo mejor, esta sigue siendo la mejor disponible.
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
 * Fusiona el enriquecimiento sobre los datos del scraper SIN pisarlos:
 * - título del scraper siempre gana (es la identidad que trae la ficha real);
 * - sinopsis/poster/año/etc. del enriquecedor solo llenan campos vacíos o placeholder;
 * - ningún valor placeholder del enriquecedor se aplica jamás.
 */
export function applyEnrichmentGapFill(
  input: ScraperMetadataInput,
  target: MergeableMetadataTarget,
  enriched: EnrichedLike | null | undefined
): void {
  if (!enriched) return;

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

  // Título: el del scraper manda SIEMPRE (input.title es requerido y no vacío)

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

  const inputGenres = Array.isArray(input.genres)
    ? input.genres.join(",")
    : input.genres || "";
  if (
    !String(inputGenres).trim() &&
    Array.isArray(enriched.genres) &&
    enriched.genres.length > 0
  ) {
    target.genresStr = enriched.genres.join(", ");
  }
}
