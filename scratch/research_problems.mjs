import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('=== 1. Non-anime in Anime check ===');
  const samples = await prisma.show.findMany({
    where: {
      OR: [
        { title: { contains: 'Blackout', mode: 'insensitive' } },
        { title: { contains: 'CAMP', mode: 'insensitive' } },
        { title: { contains: 'The Black Bible', mode: 'insensitive' } },
        { title: { contains: '살목지' } },
        { title: { contains: 'Kanojo, Okarishimasu', mode: 'insensitive' } }
      ]
    },
    select: {
      id: true,
      title: true,
      category: true,
      genres: true,
      episodes: {
        take: 3,
        select: {
          id: true,
          episode_number: true,
          title: true,
          source_url: true,
        }
      }
    }
  });
  console.log('Found samples:', JSON.stringify(samples, null, 2));

  console.log('=== 2. How are shows queried by category on API? ===');
  const animeCategoryCount = await prisma.show.count({
    where: { category: { equals: 'anime', mode: 'insensitive' } }
  });
  console.log('Shows with category=anime:', animeCategoryCount);

  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
