const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const show = await prisma.show.findFirst({
    where: { title: { contains: 'detras de ti' } },
    include: { episodes: true }
  });
  console.log(JSON.stringify(show, null, 2));
}

run().finally(() => prisma.$disconnect());
