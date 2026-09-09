// src/utils/imageSizes.ts
//
// Selección de imágenes adaptativa por layout. El servidor guarda rutas crudas
// de TMDB (poster_path/backdrop_path) y estos helpers materializan únicamente
// el tamaño apropiado para cada contexto. Se evita `original` para no castigar
// conexiones móviles y se reserva más resolución para pósters por el DPR alto
// de teléfonos modernos.

export type TmdbImageSize = 'w92' | 'w154' | 'w185' | 'w342' | 'w500' | 'w780' | 'w1280' | 'original';

export interface TmdbImagePaths {
  poster_path?: string | null;
  backdrop_path?: string | null;
}

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/';
const TMDB_URL_RE = /https?:\/\/image\.tmdb\.org\/t\/p\/(?:original|w\d+)(\/[^?#]+)([?#].*)?$/i;
const TITLE_ART_RE = /\.(?:png|svg)(?:[?#]|$)/i;

function usablePosterCandidate(url: string | null): string | null {
  if (!url) return null;
  // A few catalog imports contain a transparent title/logo image rather than
  // a poster. Do not let that asset win the card fallback chain.
  return TITLE_ART_RE.test(url) ? null : url;
}

export function sizedImageUrl(url: string | null | undefined, size: TmdbImageSize): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return trimmed.replace(TMDB_URL_RE, `${TMDB_IMAGE_BASE}${size}$1$2`);
}

export function tmdbImageUrl(path: string | null | undefined, size: TmdbImageSize): string | null {
  if (!path || typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed || !trimmed.startsWith('/')) return null;
  return `${TMDB_IMAGE_BASE}${size}${trimmed}`;
}

export type ImageSourceMedia = Partial<TmdbImagePaths> & {
  banner_url?: string | null;
  backdrop_url?: string | null;
  poster_url?: string | null;
};

type ResponsiveCandidate = { size: TmdbImageSize; width: number };

function responsiveTmdbSrcSet(
  path: string | null | undefined,
  fallbackUrl: string | null | undefined,
  candidates: ResponsiveCandidate[],
): string | undefined {
  if (path?.trim().startsWith('/') && !TITLE_ART_RE.test(path)) {
    return candidates
      .map(({ size, width }) => `${tmdbImageUrl(path, size)} ${width}w`)
      .join(', ');
  }

  const source = String(fallbackUrl || '').trim();
  if (!source || !TMDB_URL_RE.test(source)) return undefined;
  return candidates
    .map(({ size, width }) => `${sizedImageUrl(source, size)} ${width}w`)
    .join(', ');
}

/** Hero: backdrop 1280px como fallback; el navegador puede elegir original en DPR/pantallas grandes. */
export function heroBackdropUrl(m: ImageSourceMedia): string | null {
  return (
    tmdbImageUrl(m.backdrop_path, 'w1280') ||
    sizedImageUrl(m.banner_url, 'w1280') ||
    sizedImageUrl(m.backdrop_url, 'w1280') ||
    sizedImageUrl(m.poster_url, 'w1280') ||
    null
  );
}

export function heroBackdropSrcSet(m: ImageSourceMedia): string | undefined {
  const fallback = m.banner_url || m.backdrop_url || m.poster_url;
  return responsiveTmdbSrcSet(m.backdrop_path, fallback, [
    { size: 'w500', width: 500 },
    { size: 'w780', width: 780 },
    { size: 'w1280', width: 1280 },
    { size: 'original', width: 1920 },
  ]);
}

export function bentoBackdropUrl(m: ImageSourceMedia): string | null {
  return (
    tmdbImageUrl(m.backdrop_path, 'w1280') ||
    sizedImageUrl(m.banner_url, 'w1280') ||
    sizedImageUrl(m.backdrop_url, 'w1280') ||
    sizedImageUrl(m.poster_url, 'w1280') ||
    null
  );
}

export function bentoBackdropSrcSet(m: ImageSourceMedia): string | undefined {
  const fallback = m.banner_url || m.backdrop_url || m.poster_url;
  return responsiveTmdbSrcSet(m.backdrop_path, fallback, [
    { size: 'w500', width: 500 },
    { size: 'w780', width: 780 },
    { size: 'w1280', width: 1280 },
  ]);
}

/**
 * Cards: w342 es el punto dulce para tarjetas de ~140–200 CSS px en pantallas
 * 2x. Antes se solicitaba w185 para `poster_path`, que se veía blando en móvil
 * y Retina aunque existiera un póster TMDB de mayor calidad.
 */
export function cardPosterUrl(m: ImageSourceMedia): string | null {
  return cardPosterCandidates(m)[0] || null;
}

/**
 * Ordered artwork fallbacks for a poster slot. The first URL is still the
 * canonical TMDB poster; the remaining entries are only requested when the
 * previous image actually fails, so search grids do not preload extra memory.
 */
export function cardPosterCandidates(m: ImageSourceMedia): string[] {
  return [
    tmdbImageUrl(m.poster_path, 'w342'),
    sizedImageUrl(m.poster_url, 'w342'),
    sizedImageUrl(m.banner_url, 'w342'),
    sizedImageUrl(m.backdrop_url, 'w342'),
  ].map(usablePosterCandidate).filter((value): value is string => Boolean(value));
}

export function cardPosterSrcSet(m: ImageSourceMedia): string | undefined {
  const fallback = [m.poster_url, m.banner_url, m.backdrop_url]
    .map((value) => String(value || '').trim())
    .find((value) => value && !TITLE_ART_RE.test(value));
  return responsiveTmdbSrcSet(m.poster_path, fallback, [
    { size: 'w342', width: 342 },
    { size: 'w500', width: 500 },
    { size: 'w780', width: 780 },
  ]);
}

/** Seguir viendo: backdrop mediano 16:9. */
export function thumbBackdropUrl(m: ImageSourceMedia): string | null {
  return (
    tmdbImageUrl(m.backdrop_path, 'w780') ||
    sizedImageUrl(m.backdrop_url, 'w780') ||
    sizedImageUrl(m.banner_url, 'w780') ||
    sizedImageUrl(m.poster_url, 'w780') ||
    null
  );
}

export function thumbBackdropSrcSet(m: ImageSourceMedia): string | undefined {
  const fallback = m.backdrop_url || m.banner_url || m.poster_url;
  return responsiveTmdbSrcSet(m.backdrop_path, fallback, [
    { size: 'w342', width: 342 },
    { size: 'w500', width: 500 },
    { size: 'w780', width: 780 },
  ]);
}
