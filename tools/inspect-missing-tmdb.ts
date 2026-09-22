import { prisma } from '../server/db';

async function run() {
  const total = await prisma.show.count();
  const missingTmdb = await prisma.show.count({ where: { tmdb_id: null } });
  const withTmdbImg = await prisma.show.count({
    where: {
      tmdb_id: null,
      poster_url: { contains: 'tmdb.org' }
    }
  });
  console.log(JSON.stringify({ total, missingTmdb, withTmdbImg }, null, 2));
}

run().catch(console.error).finally(() => prisma.$disconnect());
