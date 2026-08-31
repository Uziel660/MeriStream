import { prisma } from '../server/db';
async function run() {
  const shows = await prisma.show.findMany({ where: { title: { contains: 'testament', mode: 'insensitive' } } });
  console.log(shows.map(s => s.title));
}
run().finally(() => process.exit(0));
