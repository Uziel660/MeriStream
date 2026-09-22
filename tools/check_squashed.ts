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
  
  console.log("Shows found:", shows.length);
  for (const s of shows) {
    console.log(`- ${s.title} (ID: ${s.id})`);
    console.log(`  Genres: ${typeof s.genres === 'string' ? s.genres : JSON.stringify(s.genres)}`);
    console.log(`  TMDB: ${s.tmdb_id}, MAL: ${s.mal_id}`);
    console.log(`  Poster: ${s.poster_url}`);
  }
}
check().finally(() => prisma.$disconnect());
