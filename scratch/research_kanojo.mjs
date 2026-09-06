import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const kanojo = await prisma.show.findMany({
    where: { title: { contains: 'kanojo', mode: 'insensitive' } },
    select: {
      id: true,
      title: true,
      category: true,
      episodes: {
        take: 5,
        select: {
          id: true,
          episode_number: true,
          title: true,
          source_url: true,
        }
      }
    }
  });
  console.log('KANOJO SHOWS:', JSON.stringify(kanojo, null, 2));

  // Also check MediaItem and SourceLink for one of the Kanojo episodes
  if (kanojo.length > 0 && kanojo[0].episodes.length > 0) {
    const epId = kanojo[0].episodes[0].id;
    const mediaEp = await prisma.mediaEpisode.findFirst({
      where: {
        OR: [
          { id: epId },
          { media_item: { normalized_title: { contains: 'kanojo' } } }
        ]
      },
      include: {
        links: true,
        media_item: true
      }
    });
    console.log('MEDIA EPISODE LINKS:', JSON.stringify(mediaEp, null, 2));
  }

  await prisma.$disconnect();
}

main().catch(console.error);
