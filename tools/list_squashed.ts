import { prisma } from '../server/db';
async function count() {
  const shows = await prisma.show.findMany({ select: { id: true, title: true } });
  const squashed = shows.filter(s => !s.title.includes(' ') && s.title.length >= 15);
  for (const s of squashed) {
    console.log(s.title);
  }
}
count().finally(() => process.exit(0));
