const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Let's check how many gnula shows have an exact title match in another Show with a tmdb poster
  const gnulaShows = await prisma.show.findMany({
    where: { poster_url: { contains: 'gnulahd.nu' } },
    select: { id: true, title: true, category: true, poster_url: true }
  });

  console.log(`Total gnula shows: ${gnulaShows.length}`);

  let matchesWithTmdb = 0;
  for (const g of gnulaShows.slice(0, 100)) {
    const counterpart = await prisma.show.findFirst({
      where: {
        title: { equals: g.title, mode: 'insensitive' },
        id: { not: g.id },
        poster_url: { contains: 'image.tmdb.org' }
      },
      select: { id: true, title: true, poster_url: true, tmdb_id: true }
    });
    if (counterpart) matchesWithTmdb++;
  }

  console.log(`In first 100 gnula shows, ${matchesWithTmdb} have a counterpart with real TMDB poster.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
