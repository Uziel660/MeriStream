import { describe, expect, it } from 'vitest';
import { normalizeTextStrict, searchShows } from './searchUtils';
import type { Show } from '../types';

const show = (title: string, extra: Partial<Show> = {}): Show => ({
  id: title,
  title,
  category: 'anime',
  ...extra,
});

describe('searchUtils', () => {
  it('corrige errores de varias palabras y mantiene el resultado más cercano primero', () => {
    const results = searchShows([
      show('Operaciones Especiales: Lioness', { english_title: 'Special Ops: Lioness' }),
      show('One Piece', { english_title: 'One Piece' }),
      show('One Room'),
    ], 'one pecie');

    expect(results[0].title).toBe('One Piece');
  });

  it('permite buscar por alias traducido y por título unido', () => {
    const results = searchShows([
      show('La isla del minotauro', { title_aliases: ['My Brother the Minotaur'] }),
      show('Otra historia'),
    ], 'mybrother theminotaur');

    expect(results[0].title).toBe('La isla del minotauro');
  });

  it('encuentra una ficha cuyo título visible fue localizado por TMDB', () => {
    const results = searchShows([
      show('Link Click', { title_aliases: ['Shiguang Dailiren', '时光代理人'] }),
      show('Otra historia'),
    ], 'Shiguang Dailiren');

    expect(results[0].title).toBe('Link Click');
  });

  it('no destruye títulos japoneses al compactar la búsqueda', () => {
    expect(normalizeTextStrict('進撃の巨人')).toBe('進撃の巨人');
  });
});
