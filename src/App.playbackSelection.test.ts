import { describe, expect, it } from 'vitest';
import {
  findEpisodeProgress,
  getEpisodePlaybackContext,
  isPublicVirtualEpisode,
  limitGatewaySources,
  mergeRankedStreams,
  toGatewayFallbacks,
  toGatewayRankedStreams,
} from './App';
import type { Episode, Show } from './types';
import type { WatchProgress } from './components/ContinueWatching';

const episode: Episode = {
  id: 'ep-2',
  show_id: 'tmdb-anime-21',
  title: 'Episode 2',
  episode_number: 2,
};

describe('App playback selection helpers', () => {
  it('preserves public catalog identity and infers the gateway kind from its canonical id', () => {
    const knownShow: Show = { id: episode.show_id!, title: 'Known anime', category: 'anime', kind: 'anime' };
    const context = getEpisodePlaybackContext({
      episode,
      showTitle: 'Fallback title',
      selectedShowId: 'local-id',
      shows: [knownShow],
      searchResults: [],
      routeKind: 'movie',
    });

    expect(context).toMatchObject({
      showId: 'tmdb-anime-21',
      currentShow: { id: 'tmdb-anime-21', tmdb_id: 21, kind: 'anime', category: 'anime' },
      kindForUrl: 'anime',
      gatewayKind: 'anime',
    });
  });

  it('looks up progress by canonical episode id before number/title fallbacks', () => {
    const items: WatchProgress[] = [
      { showId: 'tmdb-anime-21', showTitle: 'Other title', episodeId: 'other', episodeNumber: 2, episodeTitle: 'Episode 2', progressPercent: 90, lastWatchedAt: 1 },
      { showId: 'tmdb-anime-21', showTitle: 'Known anime', episodeId: 'ep-2', episodeNumber: 2, episodeTitle: 'Episode 2', progressPercent: 35, lastWatchedAt: 2 },
    ];

    expect(findEpisodeProgress(items, 'tmdb-anime-21', episode, 'Known anime')).toBe(items[1]);
  });

  it('limits each provider to three sources without limiting other providers', () => {
    const sources = [
      ...Array.from({ length: 4 }, (_, index) => ({ provider: 'Foo', url: `https://foo.example/${index}` })),
      { provider: 'bar', url: 'https://bar.example/1' },
    ];

    expect(limitGatewaySources(sources).map((source) => source.url)).toEqual([
      'https://foo.example/0', 'https://foo.example/1', 'https://foo.example/2', 'https://bar.example/1',
    ]);
  });

  it('prefers legacy direct streams over gateway embeds and keeps the first URL occurrence', () => {
    const direct = toGatewayRankedStreams([
      { provider: 'cdn', url: 'https://www.cdn.example/master.m3u8', canonicalLocator: 'https://source.example/watch/1', requiredHeaders: { Referer: 'https://source.example' } },
    ], () => null);
    const fallback = toGatewayFallbacks([
      { provider: 'embed', url: 'https://embed.example/watch/1', type: 'embed' },
    ], direct.length, () => null);
    const legacy = [{ url: 'https://legacy.example/master.m3u8', type: 'direct', provider: 'legacy' }];
    const merged = mergeRankedStreams(direct, legacy, fallback, [{ url: direct[0].url, provider: 'duplicate' }]);

    expect(direct[0]).toMatchObject({
      host: 'cdn.example',
      canonical_locator: 'https://source.example/watch/1',
      delivery_mode: 'proxy_required',
      is_refreshable: true,
      tier: 0,
    });
    expect(fallback[0]).toMatchObject({ type: 'embed', tier: 1, delivery_mode: 'embed' });
    expect(merged.map((item) => item.url)).toEqual([direct[0].url, legacy[0].url, fallback[0].url]);
  });

  it('recognizes virtual episodes from public catalog ids only', () => {
    expect(isPublicVirtualEpisode('tmdb-anime-21-s1-e2', 'legacy-show')).toBe(true);
    expect(isPublicVirtualEpisode('episode-2', 'tmdb-series-456')).toBe(true);
    expect(isPublicVirtualEpisode('episode-2', 'legacy-show')).toBe(false);
  });
});
