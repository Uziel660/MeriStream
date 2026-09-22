import { prisma } from '../server/db';

async function run() {
  const moviesWithMultipleEpisodes = await prisma.show.findMany({
    where: {
      category: 'movie',
      episodes: {
        some: {
          episode_number: { gt: 1 }
        }
      }
    },
    select: {
      id: true,
      title: true,
      tmdb_id: true,
      category: true,
      episodes: {
        select: {
          id: true,
          episode_number: true,
          title: true,
          source_url: true
        }
      }
    }
  });

  console.log(`Found ${moviesWithMultipleEpisodes.length} movies with multiple episodes.`);

  for (const m of moviesWithMultipleEpisodes.slice(0, 15)) {
    console.log(`--- ${m.title} (ID: ${m.id}, TMDB: ${m.tmdb_id}, total eps: ${m.episodes.length}) ---`);
    for (const ep of m.episodes.slice(0, 5)) {
      console.log(`  S${ep.season_number}E${ep.episode_number}: "${ep.title}" -> ${ep.server_name || ''} | ${ep.source_url?.slice(0, 60)}`);
    }
  }
}

run().catch(console.error).finally(() => prisma.$disconnect());
