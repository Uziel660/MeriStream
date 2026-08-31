const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const item = await prisma.mediaEpisode.findFirst({
    where: { links: { some: { source_site: 'lamovie.org' } } },
    include: { media_item: true, links: true }
  });
  console.log(JSON.stringify(item, null, 2));
}
main().finally(() => prisma.$disconnect());
