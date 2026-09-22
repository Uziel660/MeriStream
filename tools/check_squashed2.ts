import { prisma } from '../server/db';

async function check() {
  const titles = [
    'Testamentthestoryofmoses',
    'Unicotestigo',
    'Testigoprotegido',
    'Eltestamentodelaabuela',
    'Bakatotesttoshoukanjuu'
  ];
  
  const shows = await prisma.show.findMany({
    where: { title: { in: titles } }
  });
  
  for (const s of shows) {
    console.log(`\n- ${s.title}`);
    console.log(`  original_title: ${s.original_title}`);
    console.log(`  english_title: ${s.english_title}`);
    console.log(`  base_normalized: ${s.base_normalized_title}`);
    console.log(`  description: ${s.description?.substring(0, 50)}...`);
  }
}
check().finally(() => prisma.$disconnect());
