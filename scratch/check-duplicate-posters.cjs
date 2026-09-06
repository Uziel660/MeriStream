const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const dupes = await prisma.$queryRaw`
    SELECT poster_url, COUNT(*) as cnt
    FROM "Show"
    WHERE poster_url IS NOT NULL AND poster_url != ''
    GROUP BY poster_url
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 30;
  `;

  console.log('TOP DUPLICATE POSTERS IN SHOW TABLE:');
  for (const d of dupes) {
    const showsWithPoster = await prisma.show.findMany({
      where: { poster_url: d.poster_url },
      select: { title: true, id: true, source: true },
      take: 5
    });
    console.log(`Poster: ${d.poster_url} (Used by ${d.cnt} shows)`);
    console.log(`  Sample shows:`, showsWithPoster.map(s => s.title).join(', '));
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
