const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const countGnulaPosters = await prisma.show.count({
    where: {
      poster_url: { contains: 'gnulahd.nu' }
    }
  });

  const sampleGnula = await prisma.show.findMany({
    where: {
      poster_url: { contains: 'gnulahd.nu' }
    },
    take: 15,
    select: { id: true, title: true, poster_url: true, category: true, source: true }
  });

  console.log('Total shows with gnulahd.nu posters:', countGnulaPosters);
  console.log('Sample:', JSON.stringify(sampleGnula, null, 2));

  // Check how many have a corresponding series/movie with tmdb_id or better poster
  let fixable = 0;
  for (const s of sampleGnula) {
    const better = await prisma.show.findFirst({
      where: {
        title: { equals: s.title, mode: 'insensitive' },
        id: { not: s.id },
        poster_url: { contains: 'tmdb.org' }
      },
      select: { id: true, title: true, poster_url: true }
    });
    if (better) fixable++;
    console.log(`"${s.title}" -> better poster?`, better?.poster_url || 'NONE');
  }
  console.log('Fixable in sample:', fixable);
}

main().catch(console.error).finally(() => prisma.$disconnect());
