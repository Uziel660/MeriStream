import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalIdResolver, normalizePreferredLanguages } from './ExternalIdResolver';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('ExternalIdResolver', () => {
  it('keeps the direct external_ids path for movies', async () => {
    vi.stubEnv('TMDB_API_KEY', 'test-key');
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/movie/550/external_ids');
      return new Response(JSON.stringify({ imdb_id: 'tt0137523' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new ExternalIdResolver(1_000).resolve({ tmdbId: 550, kind: 'movie' });
    expect(result).toBe('tt0137523');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('selects the movie namespace for an anime movie only after title/year validation', async () => {
    vi.stubEnv('TMDB_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/tv/372058?')) {
        return new Response(JSON.stringify({
          name: 'Unrelated TV Show', original_name: 'Unrelated TV Show', first_air_date: '2022-01-01',
          external_ids: { imdb_id: 'tt9999999' },
        }), { status: 200 });
      }
      if (url.includes('/movie/372058?')) {
        return new Response(JSON.stringify({
          title: 'Your Name.', original_title: '君の名は。', release_date: '2016-08-26',
          external_ids: { imdb_id: 'tt5311514' },
        }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    }));

    const result = await new ExternalIdResolver(1_000).resolve({
      tmdbId: 372058,
      kind: 'anime',
      title: 'Kimi no Na wa',
      titleAliases: ['Your Name.'],
      year: 2016,
    });
    expect(result).toBe('tt5311514');
  });

  it('rejects an unrelated IMDb even when the numeric TMDB id exists in both namespaces', async () => {
    vi.stubEnv('TMDB_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/tv/123?')) {
        return new Response(JSON.stringify({ name: 'Different Series', first_air_date: '2019-01-01', external_ids: { imdb_id: 'tt1111111' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ title: 'Different Movie', release_date: '2020-01-01', external_ids: { imdb_id: 'tt2222222' } }), { status: 200 });
    }));

    const result = await new ExternalIdResolver(1_000).resolve({
      tmdbId: 123,
      kind: 'anime',
      title: 'Expected Anime',
      year: 2024,
    });
    expect(result).toBeNull();
  });
});

describe('normalizePreferredLanguages', () => {
  it('keeps regional Spanish discoverable when legacy clients request generic Spanish', () => {
    expect(normalizePreferredLanguages(['es', 'en'])).toEqual(['es-419', 'es-ES', 'es', 'en']);
  });

  it('preserves an explicit Latino → Castellano → generic order', () => {
    expect(normalizePreferredLanguages(['es-419', 'es-ES', 'es', 'en']))
      .toEqual(['es-419', 'es-ES', 'es', 'en']);
  });

  it('does not broaden a Castellano-only request to Latino', () => {
    expect(normalizePreferredLanguages(['es-ES', 'en'])).toEqual(['es-ES', 'en']);
  });

  it('keeps the historical Spanish-first default compatible', () => {
    expect(normalizePreferredLanguages()).toEqual(['es-419', 'es', 'en']);
  });
});
