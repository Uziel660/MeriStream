import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const showCount = await prisma.show.count();
  const episodeCount = await prisma.episode.count();
  const sourceCount = await prisma.sourceLink.count();

  const tasks = await prisma.crawlTask.findMany({
    orderBy: { updated_at: 'desc' },
    take: 10,
    select: {
      name: true,
      scope: true,
      status: true,
      total_discovered: true,
      shows_imported: true,
      episodes_imported: true,
      error_message: true,
      updated_at: true,
    }
  });

  const groups = await prisma.crawlTask.groupBy({
    by: ['scope', 'status'],
    _count: { _all: true },
    _sum: { total_discovered: true, shows_imported: true, episodes_imported: true },
  });

  console.log(JSON.stringify({
    counts: { showCount, episodeCount, sourceCount },
    groups,
    latestTasks: tasks
  }, null, 2));

  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
