// Obtiene una muestra de URLs reales por plataforma
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const platforms = [
    'animeflv.net',
    'tioanime.com',
    'jkanime.net',
    'latanime.com',
    'veranimes.net',
    'lamovie.org',
    'cinecalidad.to',
    'tioplus.app',
  ];

  for (const platform of platforms) {
    const links = await prisma.sourceLink.findMany({
      where: { source_site: platform },
      take: 2,
      orderBy: { last_checked: 'desc' },
    });
    const linkTypes = [...new Set(links.map(l => l.link_type))];
    const sample = links[0]?.url || 'N/A';
    console.log(`${platform}: ${links.length >= 2 ? links.length : 'few'} links | type=${linkTypes.join('/')} | sample=${sample}`);
  }

  // Contar cuántas URLs tienen stream_url directo vs embed
  const directCount = await prisma.sourceLink.count({ where: { link_type: 'direct' } });
  const embedCount = await prisma.sourceLink.count({ where: { link_type: 'embed' } });
  const total = await prisma.sourceLink.count();
  console.log(`\nTotal links: ${total} | direct: ${directCount} | embed: ${embedCount}`);
}

main().finally(() => prisma.$disconnect());
