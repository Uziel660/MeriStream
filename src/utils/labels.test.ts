import { describe, it, expect } from 'vitest';
import { contentLabel } from './labels';

describe('contentLabel', () => {
  it('returns "Anime" for null, undefined, or empty string', () => {
    expect(contentLabel(null)).toBe('Anime');
    expect(contentLabel(undefined)).toBe('Anime');
    expect(contentLabel('')).toBe('Anime');
    expect(contentLabel('   ')).toBe('Anime');
  });

  it('returns "Película" for movie tokens', () => {
    const movieTokens = ['movie', 'movies', 'pelicula', 'película', 'peliculas', 'películas', 'cine'];
    for (const token of movieTokens) {
      expect(contentLabel(token)).toBe('Película');
      expect(contentLabel(` ${token.toUpperCase()} `)).toBe('Película');
    }
  });

  it('returns "Serie" for series tokens', () => {
    const seriesTokens = ['serie', 'series', 'tv', 'tvshow', 'tvshows', 'show'];
    for (const token of seriesTokens) {
      expect(contentLabel(token)).toBe('Serie');
      expect(contentLabel(` ${token.toUpperCase()} `)).toBe('Serie');
    }
  });

  it('returns "Anime" for anime tokens', () => {
    const animeTokens = ['anime', 'animes', 'animacion', 'animación'];
    for (const token of animeTokens) {
      expect(contentLabel(token)).toBe('Anime');
      expect(contentLabel(` ${token.toUpperCase()} `)).toBe('Anime');
    }
  });

  it('returns capitalized string for unknown tokens', () => {
    expect(contentLabel('documentary')).toBe('Documentary');
    expect(contentLabel('   documentary   ')).toBe('Documentary');
    expect(contentLabel('DOCUMENTARY')).toBe('Documentary');
    expect(contentLabel('short')).toBe('Short');
  });
});
