import { prisma } from '../server/db';
async function count() {
  const shows = await prisma.show.findMany({ select: { id: true, title: true, original_title: true } });
  const squashed = shows.filter(s => !s.title.includes(' ') && s.title.length >= 10);
  console.log(`Found ${squashed.length} squashed titles`);
  for (const s of squashed.slice(0, 100)) {
    console.log(`${s.title} (orig: ${s.original_title})`);
  }
}
count().finally(() => process.exit(0));
