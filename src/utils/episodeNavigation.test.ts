import { describe, expect, it } from 'vitest';
import type { Episode } from '../types';
import { getNextEpisode } from './episodeNavigation';

describe('episode navigation', () => {
  it('orders episodes by season and then episode, including season boundaries', () => {
    const episodes: Episode[] = [
      { id: 's2e2', title: 'Season 2 Episode 2', season_number: 2, episode_number: 2 },
      { id: 's1e2', title: 'Season 1 Episode 2', season_number: 1, episode_number: 2 },
      { id: 's2e1', title: 'Season 2 Episode 1', season_number: 2, episode_number: 1 },
      { id: 's1e1', title: 'Season 1 Episode 1', season_number: 1, episode_number: 1 },
    ];

    expect(getNextEpisode(episodes, { id: 's1e2', episode_number: 2, season_number: 1 })?.id).toBe('s2e1');
  });

  it('matches the current episode by id before duplicate episode numbers', () => {
    const episodes: Episode[] = [
      { id: 's1e2', title: 'Season 1 Episode 2', season_number: 1, episode_number: 2 },
      { id: 's2e2', title: 'Season 2 Episode 2', season_number: 2, episode_number: 2 },
      { id: 's2e3', title: 'Season 2 Episode 3', season_number: 2, episode_number: 3 },
    ];

    expect(getNextEpisode(episodes, { id: 's2e2', episode_number: 2, season_number: 2 })?.id).toBe('s2e3');
  });

  it('uses season and episode number when the current id is stale', () => {
    const episodes: Episode[] = [
      { id: 's1e2', title: 'Season 1 Episode 2', season_number: 1, episode_number: 2 },
      { id: 's2e2', title: 'Season 2 Episode 2', season_number: 2, episode_number: 2 },
      { id: 's2e3', title: 'Season 2 Episode 3', season_number: 2, episode_number: 3 },
    ];

    expect(getNextEpisode(episodes, { id: 'old-id', episode_number: 2, season_number: 2 })?.id).toBe('s2e3');
  });

  it('returns no next episode at the end of the known episode list', () => {
    const finalEpisode: Episode = {
      id: 's2e3',
      title: 'Season 2 Episode 3',
      season_number: 2,
      episode_number: 3,
    };

    expect(getNextEpisode([finalEpisode], finalEpisode)).toBeUndefined();
  });
});
