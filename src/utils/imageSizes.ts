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

export function sizedImageUrl(url: string | null | undefined, size: TmdbImageSize): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return trimmed.replace(
    /https?:\/\/image\.tmdb\.org\/t\/p\/(?:original|w\d+)(\/[^?#]+)([?#].*)?$/i,
    `${TMDB_IMAGE_BASE}${size}$1$2`,
  );
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

/** Hero: backdrop 1280px, nítido sin descargar originales de varios megabytes. */
export function heroBackdropUrl(m: ImageSourceMedia): string | null {
  return (
    tmdbImageUrl(m.backdrop_path, 'w1280') ||
    sizedImageUrl(m.banner_url, 'w1280') ||
    sizedImageUrl(m.backdrop_url, 'w1280') ||
    sizedImageUrl(m.poster_url, 'w1280') ||
    null
  );
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

/**
 * Cards: w342 es el punto dulce para tarjetas de ~140–200 CSS px en pantallas
 * 2x. Antes se solicitaba w185 para `poster_path`, que se veía blando en móvil
 * y Retina aunque existiera un póster TMDB de mayor calidad.
 */
export function cardPosterUrl(m: ImageSourceMedia): string | null {
  return (
    tmdbImageUrl(m.poster_path, 'w342') ||
    sizedImageUrl(m.poster_url, 'w342') ||
    sizedImageUrl(m.banner_url, 'w342') ||
    sizedImageUrl(m.backdrop_url, 'w342') ||
    null
  );
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
