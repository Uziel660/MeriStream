const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const shows = await prisma.show.findMany({
    orderBy: { created_at: 'desc' },
    take: 20,
    select: {
      id: true,
      title: true,
      poster_url: true,
      category: true,
      year: true,
      source: true,
      tmdb_id: true,
      episodes: {
        select: { id: true, source_url: true },
        take: 1
      }
    }
  });

  console.log(JSON.stringify(shows, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
