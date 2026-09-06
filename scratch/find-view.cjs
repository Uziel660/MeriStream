const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Let's check when these shows were created and in which table
  const shows = await prisma.show.findMany({
    where: {
      title: {
        in: [
          'Super Subbu',
          'El Hombre Vapor',
          'Una Familia Complicada',
          'Deep Revenge',
          'Los del lado oeste',
          'El complejo de apartamentos'
        ]
      }
    },
    select: {
      id: true,
      title: true,
      category: true,
      year: true,
      rating: true,
      created_at: true,
      updated_at: true,
      poster_url: true,
      source: true
    }
  });
  console.log('SHOWS IN DB:');
  console.log(JSON.stringify(shows, null, 2));

  // Also check MediaItem
  const media = await prisma.mediaItem.findMany({
    where: {
      title: {
        in: [
          'Super Subbu',
          'El Hombre Vapor',
          'Una Familia Complicada',
          'Deep Revenge',
          'Los del lado oeste',
          'El complejo de apartamentos'
        ]
      }
    },
    select: {
      id: true,
      title: true,
      kind: true,
      year: true,
      rating: true,
      created_at: true,
      updated_at: true,
      poster_url: true
    }
  });
  console.log('MEDIA ITEMS IN DB:');
  console.log(JSON.stringify(media, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
