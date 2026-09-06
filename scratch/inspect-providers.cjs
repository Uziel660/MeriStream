const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Check providers in Show table
  const showSources = await prisma.$queryRaw`
    SELECT source, COUNT(*)::int as count
    FROM "Show"
    GROUP BY source
    ORDER BY count DESC;
  `;
  console.log('=== SHOW SOURCES ===');
  console.table(showSources);

  // Check providers in SourceLink table
  const linkSites = await prisma.$queryRaw`
    SELECT source_site, COUNT(*)::int as count
    FROM "SourceLink"
    GROUP BY source_site
    ORDER BY count DESC;
  `;
  console.log('=== SOURCELINK SITES ===');
  console.table(linkSites);
}

main().catch(console.error).finally(() => prisma.$disconnect());
