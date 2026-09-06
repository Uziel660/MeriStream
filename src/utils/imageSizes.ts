// src/utils/imageSizes.ts
//
// Selección de imágenes adaptativa por layout. El servidor (Fase 1) empieza a
// guardar rutas crudas TMDB (poster_path/backdrop_path, ej "/abc123.jpg");
// TMDB las sirve en image.tmdb.org/t/p/{size}{path} con recorte exacto por uso:
// posters verticales 2:3 (w92..w342), backdrops horizontales 16:9 (w780..original).
// Si no hay ruta TMDB, los helpers devuelven las URLs existentes tal cual y
// SmartImage/proxy siguen funcionando igual.

export type TmdbImageSize = 'w92' | 'w154' | 'w185' | 'w342' | 'w500' | 'w780' | 'w1280' | 'original';

/**
 * Campos crudos de imagen que el servidor puede empezar a emitir sin pasar por
 * types.ts (los añade el agente META en su propia rama).
 */
export interface TmdbImagePaths {
  poster_path?: string | null;
  backdrop_path?: string | null;
}

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/';

/**
 * Reduce URLs TMDB ya materializadas (incluido `/original/`) al tamaño que
 * necesita el layout. Algunos registros antiguos solo guardan `banner_url` o
 * `poster_url`, por lo que no pasan por `poster_path`/`backdrop_path`.
 */
export function sizedImageUrl(url: string | null | undefined, size: TmdbImageSize): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return trimmed.replace(
    /https?:\/\/image\.tmdb\.org\/t\/p\/(?:original|w\d+)(\/[^?#]+)([?#].*)?$/i,
    `${TMDB_IMAGE_BASE}${size}$1$2`,
  );
}

/** Regenera una URL TMDB desde la ruta cruda; null si no hay path utilizable. */
export function tmdbImageUrl(path: string | null | undefined, size: TmdbImageSize): string | null {
  if (!path || typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed || !trimmed.startsWith('/')) return null;
  return `${TMDB_IMAGE_BASE}${size}${trimmed}`;
}

/** Show con campos de imagen conocidos; acepta extras TMDB aún no tipados. */
export type ImageSourceMedia = Partial<TmdbImagePaths> & {
  banner_url?: string | null;
  backdrop_url?: string | null;
  poster_url?: string | null;
};

/** Hero a pantalla completa: w1280 (máximo 200KB, no full-res de 1-5MB). */
export function heroBackdropUrl(m: ImageSourceMedia): string | null {
  return (
    tmdbImageUrl(m.backdrop_path, 'w1280') ||
    sizedImageUrl(m.banner_url, 'w1280') ||
    sizedImageUrl(m.backdrop_url, 'w1280') ||
    sizedImageUrl(m.poster_url, 'w1280') ||
    null
  );
}

/** Tile grande del bento: backdrop 16:9 grande pero no full-res. */
export function bentoBackdropUrl(m: ImageSourceMedia): string | null {
  return (
    tmdbImageUrl(m.backdrop_path, 'w1280') ||
    sizedImageUrl(m.banner_url, 'w1280') ||
    sizedImageUrl(m.backdrop_url, 'w1280') ||
    sizedImageUrl(m.poster_url, 'w1280') ||
    null
  );
}

/** Poster vertical para cards/mini-tiles 4:5 y 2:3 (w185 = 185px, suficiente para cards de 144-192px). */
export function cardPosterUrl(m: ImageSourceMedia): string | null {
  return (
    tmdbImageUrl(m.poster_path, 'w185') ||
    sizedImageUrl(m.poster_url, 'w342') ||
    sizedImageUrl(m.banner_url, 'w342') ||
    sizedImageUrl(m.backdrop_url, 'w342') ||
    null
  );
}

/** Thumbnail horizontal 16:9 (Seguir Viendo): backdrop mediano. */
export function thumbBackdropUrl(m: ImageSourceMedia): string | null {
  return (
    tmdbImageUrl(m.backdrop_path, 'w780') ||
    sizedImageUrl(m.backdrop_url, 'w780') ||
    sizedImageUrl(m.banner_url, 'w780') ||
    sizedImageUrl(m.poster_url, 'w780') ||
    null
  );
}
