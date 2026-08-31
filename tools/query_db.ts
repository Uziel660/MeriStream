import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function run() {
  const episodes = await prisma.mediaEpisode.findMany({
    take: 3,
    include: {
      links: true,
      media_item: true
    }
  });

  for (const ep of episodes) {
    console.dir(ep, { depth: null });
  }
}

run().finally(() => prisma.$disconnect());
