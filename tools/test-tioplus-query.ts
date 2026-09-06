import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function run() {
  const links = await prisma.sourceLink.findMany({
    where: { source_site: { contains: 'tioplus' } },
    take: 5,
    include: { media_episode: { include: { media_item: true } } }
  });
  for (const l of links) {
    console.log(`Title: ${l.media_episode?.media_item?.title} | URL: ${l.url} | Loc: ${l.canonical_locator}`);
  }
}
run().finally(() => prisma.$disconnect());
