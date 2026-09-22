// src/utils/labels.ts
// Etiquetas de tipo de contenido SIEMPRE en español y consistentes.
// El usuario pidió (2026-08-24): cuando se detecte "movie", mostrar "Película".
// Nada de "movie"/"serie"/"anime" crudos mezclados con español en los rótulos.

const MOVIE_TOKENS = ['movie', 'movies', 'pelicula', 'película', 'peliculas', 'películas', 'cine'];
const SERIES_TOKENS = ['serie', 'series', 'tv', 'tvshow', 'tvshows', 'show'];
const ANIME_TOKENS = ['anime', 'animes', 'animacion', 'animación'];

export function contentLabel(category: string | null | undefined): string {
  const c = String(category || '')
    .toLowerCase()
    .trim();
  if (!c) return 'Anime';
  if (MOVIE_TOKENS.includes(c)) return 'Película';
  if (SERIES_TOKENS.includes(c)) return 'Serie';
  if (ANIME_TOKENS.includes(c)) return 'Anime';
  return c.charAt(0).toUpperCase() + c.slice(1);
}
