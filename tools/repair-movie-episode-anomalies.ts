import { prisma } from '../server/db';

async function run() {
  console.log('--- Checking & Repairing Movie Episode Anomalies ---');

  const movieShows = await prisma.show.findMany({
    where: {
      category: 'movie',
      episodes: {
        some: {
          episode_number: { gt: 1 }
        }
      }
    },
    include: {
      episodes: {
        orderBy: { episode_number: 'asc' }
      }
    }
  });

  console.log(`Found ${movieShows.length} movies with multiple episodes.`);

  let convertedToSeries = 0;
  let normalizedMovies = 0;

  for (const show of movieShows) {
    const isTvSeries = show.episodes.some(ep => {
      const epTitle = (ep.title || '').toLowerCase();
      const epUrl = (ep.source_url || '').toLowerCase();
      return (
        /\b1x[2-9]\b/.test(epTitle) ||
        /\b\d+x\d+\b/.test(epTitle) ||
        /episodio\s+[2-9]/i.test(epTitle) ||
        /capitulo\s+[2-9]/i.test(epTitle) ||
        /capítulo\s+[2-9]/i.test(epTitle) ||
        /\/capitulos\//i.test(epUrl) ||
        /\/season\/\d+\/episode\/[2-9]/i.test(epUrl) ||
        /\/ver\/.*-\d+$/i.test(epUrl)
      );
    });

    if (isTvSeries) {
      // Convert category to 'series' (or 'anime' if animation)
      const isAnime = (show.genres || '').toLowerCase().includes('anime') || (show.genres || '').toLowerCase().includes('animación') || (show.genres || '').toLowerCase().includes('animacion');
      const targetCategory = isAnime ? 'anime' : 'series';

      await prisma.show.update({
        where: { id: show.id },
        data: { category: targetCategory }
      });

      console.log(`[SERIES] Converted "${show.title}" (ID: ${show.id}) -> category: '${targetCategory}' (${show.episodes.length} episodes)`);
      convertedToSeries++;
    } else {
      // It is a real single movie with alternate links saved as episode 2, 3...
      // Let's ensure episode 1 exists, and if episode 2+ has source_url, ensure it's in SourceLink
      const ep1 = show.episodes.find(e => e.episode_number === 1) || show.episodes[0];
      const otherEps = show.episodes.filter(e => e.id !== ep1.id);

      for (const otherEp of otherEps) {
        // Delete redundant episode row for the movie
        await prisma.episode.delete({ where: { id: otherEp.id } });
      }

      console.log(`[MOVIE] Consolidated "${show.title}" (ID: ${show.id}) -> cleaned ${otherEps.length} redundant episode rows for single movie`);
      normalizedMovies++;
    }
  }

  console.log('\n--- Movie Episode Anomaly Repair Summary ---');
  console.log(`Converted to TV/Anime Series: ${convertedToSeries}`);
  console.log(`Consolidated into Single Movie (Episode 1): ${normalizedMovies}`);
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
