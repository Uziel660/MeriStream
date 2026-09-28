import type { Episode } from '../types';

export function getNextEpisode(
  episodes: readonly Episode[],
  currentEpisode: Pick<Episode, 'id' | 'episode_number' | 'season_number'>,
): Episode | undefined {
  const orderedEpisodes = [...episodes]
    .filter((episode) => Number.isFinite(Number(episode.episode_number)))
    .sort((a, b) => {
      const seasonDifference = episodeSeason(a) - episodeSeason(b);
      return seasonDifference || Number(a.episode_number) - Number(b.episode_number);
    });
  const currentId = String(currentEpisode.id || '');
  let currentIndex = currentId
    ? orderedEpisodes.findIndex((episode) => String(episode.id) === currentId)
    : -1;

  if (currentIndex < 0) {
    const currentNumber = Number(currentEpisode.episode_number);
    const currentSeason = Number(currentEpisode.season_number);
    if (!Number.isFinite(currentNumber)) return undefined;

    currentIndex = orderedEpisodes.findIndex((episode) =>
      Number(episode.episode_number) === currentNumber
      && (!Number.isFinite(currentSeason) || currentSeason < 1 || episodeSeason(episode) === currentSeason),
    );
  }

  return currentIndex >= 0 ? orderedEpisodes[currentIndex + 1] : undefined;
}

function episodeSeason(episode: Pick<Episode, 'season_number'>): number {
  const season = Number(episode.season_number);
  return Number.isFinite(season) && season >= 1 ? season : 1;
}
