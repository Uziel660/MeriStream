import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function run() {
  const showSources = await prisma.show.groupBy({
    by: ['source'],
    _count: { _all: true },
    orderBy: { _count: { source: 'desc' } }
  });
  console.log('Show.source:', showSources);

  const sourceSites = await prisma.sourceLink.groupBy({
    by: ['source_site'],
    _count: { _all: true },
    orderBy: { _count: { source_site: 'desc' } }
  });
  console.log('SourceLink.source_site:', sourceSites);
  await prisma.$disconnect();
}
run();
