const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const titles = [
    'Super Subbu',
    'El Hombre Vapor',
    'Una Familia Complicada',
    'Deep Revenge',
    'Los del lado oeste',
    'El complejo de apartamentos'
  ];

  for (const t of titles) {
    const show = await prisma.show.findFirst({
      where: { title: { contains: t, mode: 'insensitive' } },
      select: {
        id: true,
        title: true,
        poster_url: true,
        banner_url: true,
        tmdb_id: true,
        category: true,
        source: true,
        episodes: {
          select: { id: true, source_url: true },
          take: 2
        }
      }
    });

    const media = await prisma.mediaItem.findFirst({
      where: { title: { contains: t, mode: 'insensitive' } },
      select: {
        id: true,
        title: true,
        poster_url: true,
        tmdb_id: true,
        episodes: {
          select: {
            id: true,
            links: { select: { url: true, source_site: true } }
          },
          take: 2
        }
      }
    });

    console.log('==================================================');
    console.log('QUERY:', t);
    console.log('Show:', JSON.stringify(show, null, 2));
    console.log('MediaItem:', JSON.stringify(media, null, 2));
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
