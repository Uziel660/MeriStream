import { describe, expect, it } from 'vitest';
import { selectPlaybackEpisodes } from './MediaDetailsModal';
import type { Episode } from '../types';

const episodes: Episode[] = [1, 2, 3, 4].map((number) => ({
  id: `ep-${number}`,
  show_id: 'show-1',
  title: `Episode ${number}`,
  episode_number: number,
}));

describe('MediaDetailsModal episode resume selection', () => {
  it('resumes the last episode with active progress and selects the following episode', () => {
    const result = selectPlaybackEpisodes(episodes, new Map([
      ['ep-1', { percent: 100, currentTime: 120, duration: 120 }],
      ['num_2', { percent: 40, currentTime: 24, duration: 60 }],
      ['ep-3', { percent: 60, currentTime: 36, duration: 60 }],
    ]));

    expect(result).toEqual({
      currentPlaybackEpisode: episodes[2],
      nextPlaybackEpisode: episodes[3],
      isResumingCurrent: true,
    });
  });

  it('starts after the last completed episode and keeps the last episode selected at the end', () => {
    const afterSecond = selectPlaybackEpisodes(episodes, new Map([
      ['ep-2', { percent: 85, currentTime: 51, duration: 60 }],
    ]));
    expect(afterSecond.currentPlaybackEpisode).toBe(episodes[2]);
    expect(afterSecond.isResumingCurrent).toBe(false);

    const afterLast = selectPlaybackEpisodes(episodes, new Map([
      ['ep-4', { percent: 100, currentTime: 60, duration: 60 }],
    ]));
    expect(afterLast.currentPlaybackEpisode).toBe(episodes[3]);
    expect(afterLast.nextPlaybackEpisode).toBe(episodes[1]);
  });

  it('starts from the first episode with no history and handles an empty season', () => {
    expect(selectPlaybackEpisodes(episodes, new Map())).toEqual({
      currentPlaybackEpisode: episodes[0],
      nextPlaybackEpisode: episodes[1],
      isResumingCurrent: false,
    });
    expect(selectPlaybackEpisodes([], new Map())).toEqual({
      currentPlaybackEpisode: null,
      nextPlaybackEpisode: null,
      isResumingCurrent: false,
    });
  });
});
