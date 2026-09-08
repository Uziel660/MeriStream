import { describe, expect, it, vi } from 'vitest';
import { createPlaybackRequests } from './playbackBootstrap';
import type { Episode, Show } from '../types';

const episode: Episode = {
  id: 'episode/1',
  show_id: 'show-1',
  title: 'Episodio 1',
  episode_number: 1,
  season_number: 1,
};

const canonicalShow: Show = {
  id: 'tmdb-movie-550',
  title: 'Fight Club',
  tmdb_id: 550,
  imdb_id: 'tt0137523',
  category: 'movie',
  kind: 'movie',
  year: 1999,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createPlaybackRequests', () => {
  it('resolves video core while the external subtitle request is still pending', async () => {
    let finishSubtitles!: (value: Response) => void;
    const pendingSubtitles = new Promise<Response>((resolve) => { finishSubtitles = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/v1/providers/movie/550?')) {
        return response({ sources: [{ provider: 'vidsrc', url: 'https://cdn.example/master.m3u8' }] });
      }
      if (url === '/api/v1/play/episode%2F1') {
        return response({ stream_url: 'https://legacy.example/video.m3u8', ranked_streams: [] });
      }
      if (url.startsWith('/api/v1/subtitles?')) return pendingSubtitles;
      throw new Error(`unexpected request ${url}`);
    });

    const bundle = createPlaybackRequests({
      show: canonicalShow,
      episode,
      kind: 'movie',
      preferredAudio: ['es-419', 'es-ES', 'en'],
      preferredSubtitles: ['es-419', 'es-ES', 'en'],
      fetchImpl: fetchMock,
    });

    const core = await bundle.core;
    expect(core.effectiveTmdbId).toBe(550);
    expect(core.gatewayData?.sources?.[0]?.provider).toBe('vidsrc');
    expect(core.legacyData?.stream_url).toContain('legacy.example');

    let subtitlesSettled = false;
    void bundle.subtitles.then(() => { subtitlesSettled = true; });
    await Promise.resolve();
    expect(subtitlesSettled).toBe(false);

    finishSubtitles(response({ tracks: [{ id: 'es', language: 'es-419' }] }));
    await expect(bundle.subtitles).resolves.toMatchObject({
      effectiveTmdbId: 550,
      data: { tracks: [{ id: 'es', language: 'es-419' }] },
    });
  });

  it('uses HIGH-confidence title recovery once and then unlocks subtitles with the recovered TMDB id', async () => {
    const legacyShow: Show = {
      id: 'legacy-1',
      title: 'Kimi no Na wa',
      tmdb_id: null,
      imdb_id: null,
      title_aliases: ['Your Name.'],
      original_title: '君の名は。',
      category: 'anime',
      kind: 'anime',
      year: 2016,
    };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/v1/providers/resolve-title') {
        return response({
          resolved: true,
          identity: { tmdbId: 372058, confidence: 'high' },
          gateway: { sources: [{ provider: 'zokoanime', url: 'https://cdn.example/anime.m3u8' }] },
        });
      }
      if (url === '/api/v1/play/episode%2F1') return response({ error: 'not found' }, 404);
      if (url.startsWith('/api/v1/subtitles?')) return response({ tracks: [] });
      throw new Error(`unexpected request ${url}`);
    });

    const bundle = createPlaybackRequests({
      show: legacyShow,
      episode,
      kind: 'anime',
      preferredAudio: ['es-419', 'es-ES', 'ja'],
      preferredSubtitles: ['es-419', 'es-ES', 'es'],
      fetchImpl: fetchMock,
    });

    await expect(bundle.core).resolves.toMatchObject({
      effectiveTmdbId: 372058,
      recoveredIdentity: true,
      legacyStatus: 404,
      gatewayData: { sources: [{ provider: 'zokoanime' }] },
    });
    await expect(bundle.subtitles).resolves.toMatchObject({ effectiveTmdbId: 372058 });

    const recovery = requests.find((item) => item.url === '/api/v1/providers/resolve-title');
    expect(recovery?.init?.method).toBe('POST');
    const body = JSON.parse(String(recovery?.init?.body || '{}'));
    expect(body).toMatchObject({
      kind: 'anime',
      title: 'Kimi no Na wa',
      year: 2016,
      preferredAudio: ['es-419', 'es-ES', 'ja'],
      preferredSubtitles: ['es-419', 'es-ES', 'es'],
    });
    expect(body.aliases).toContain('Your Name.');
    expect(body.aliases).toContain('君の名は。');
    expect(requests.some((item) => item.url.includes('tmdb_id=372058'))).toBe(true);
  });

  it('never starts external subtitle discovery when title recovery is not HIGH', async () => {
    const legacyShow: Show = {
      id: 'legacy-2',
      title: 'Ambiguous title',
      tmdb_id: null,
      category: 'series',
      kind: 'series',
      year: 2024,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/providers/resolve-title') {
        return response({ resolved: false, reason: 'identity_not_high_confidence', confidence: 'medium' });
      }
      if (url === '/api/v1/play/episode%2F1') {
        return response({ stream_url: 'https://legacy.example/still-works.m3u8' });
      }
      if (url.startsWith('/api/v1/subtitles?')) throw new Error('subtitle lookup must not run');
      throw new Error(`unexpected request ${url}`);
    });

    const bundle = createPlaybackRequests({ show: legacyShow, episode, kind: 'series', fetchImpl: fetchMock });
    await expect(bundle.core).resolves.toMatchObject({
      effectiveTmdbId: 0,
      recoveredIdentity: false,
      gatewayData: null,
      legacyData: { stream_url: 'https://legacy.example/still-works.m3u8' },
    });
    await expect(bundle.subtitles).resolves.toEqual({ effectiveTmdbId: 0, data: null });
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/v1/subtitles?'))).toBe(false);
  });

  it('puts the exact user language order into gateway and subtitle requests', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith('/api/v1/providers/movie/550?')) return response({ sources: [] });
      if (url === '/api/v1/play/episode%2F1') return response({ error: 'none' }, 404);
      if (url.startsWith('/api/v1/subtitles?')) return response({ tracks: [] });
      throw new Error(`unexpected request ${url}`);
    });

    const bundle = createPlaybackRequests({
      show: canonicalShow,
      episode,
      kind: 'movie',
      preferredAudio: ['es-419', 'es-ES', 'es', 'en'],
      preferredSubtitles: ['es-ES', 'es-419', 'en'],
      fetchImpl: fetchMock,
    });
    await Promise.all([bundle.core, bundle.subtitles]);

    const gatewayUrl = urls.find((url) => url.startsWith('/api/v1/providers/movie/550?')) || '';
    const gatewayParams = new URLSearchParams(gatewayUrl.split('?')[1]);
    expect(gatewayParams.get('audio')).toBe('es-419,es-ES,es,en');
    expect(gatewayParams.get('subtitles')).toBe('es-ES,es-419,en');

    const subtitleUrl = urls.find((url) => url.startsWith('/api/v1/subtitles?')) || '';
    const subtitleParams = new URLSearchParams(subtitleUrl.split('?')[1]);
    expect(subtitleParams.get('languages')).toBe('es-ES,es-419,en');
    expect(subtitleParams.has('season')).toBe(false);
    expect(subtitleParams.has('episode')).toBe(false);
  });
});
