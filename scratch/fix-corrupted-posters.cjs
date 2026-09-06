const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const CORRUPTED_PATTERNS = [
  'wednesday_poster_usa',
  'uOOtwVbSr4QDjAGIifLDwpb2Pdl',
  'acVOH8Pr5LEZ7WKZCbzwNuHVr9x',
  '40eFcTzZier3DWLqldsP5VHxeoD',
  '1RRBxq1hEC7rKIp4yac96F9ObL5',
  'IMAGENdesitio.jpg',
  'the_devil_wears_prada_2',
  '3Qud19bBUrrJAzy0Ilm8gRJlJXP',
  'one_battle_after_another_poster_usa',
  '8XfIKOPmuCZLh5ooK13SPKeybWF'
];

async function fetchTmdbPoster(title, year) {
  const apiKey = process.env.TMDB_API_KEY || '15d2ea6d0dc1d476efbca3eba2b9bbfb';
  try {
    const clean = title.replace(/\s*\(\d{4}\)$/, '').trim();
    const url = `https://api.themoviedb.org/3/search/multi?api_key=${apiKey}&query=${encodeURIComponent(clean)}&language=es-MX`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const match = (data.results || []).find(r => r.poster_path && (r.title || r.name));
    if (match) {
      return {
        poster_url: `https://image.tmdb.org/t/p/w500${match.poster_path}`,
        banner_url: match.backdrop_path ? `https://image.tmdb.org/t/p/w1280${match.backdrop_path}` : null,
        tmdb_id: match.id,
        poster_path: match.poster_path,
        backdrop_path: match.backdrop_path
      };
    }
  } catch {}
  return null;
}

async function fixPosters() {
  console.log('=== INICIANDO REPARACIÓN DE PÓSTERS CORRUPTOS ===');

  // 1. Target shows identified in the user screenshot
  const targetTitles = [
    'Super Subbu',
    'El Hombre Vapor',
    'Una Familia Complicada',
    'Deep Revenge',
    'Los del lado oeste',
    'El complejo de apartamentos'
  ];

  for (const t of targetTitles) {
    console.log(`\nRevisando "${t}"...`);
    const shows = await prisma.show.findMany({
      where: { title: { equals: t, mode: 'insensitive' } },
      include: { episodes: true }
    });

    console.log(`  Encontradas ${shows.length} entradas en Show:`);
    for (const s of shows) {
      console.log(`  - ID=${s.id} Cat=${s.category} Eps=${s.episodes.length} Poster=${s.poster_url?.slice(0, 70)}`);
    }

    // Find if one has a real TMDB poster
    const goodShow = shows.find(s => s.poster_url && s.poster_url.includes('image.tmdb.org'));
    const badShows = shows.filter(s => !s.poster_url || !s.poster_url.includes('image.tmdb.org'));

    if (goodShow && badShows.length > 0) {
      for (const bad of badShows) {
        console.log(`  -> Actualizando poster de bad show ${bad.id} con datos de good show ${goodShow.id}`);
        await prisma.show.update({
          where: { id: bad.id },
          data: {
            poster_url: goodShow.poster_url,
            banner_url: goodShow.banner_url || goodShow.poster_url,
            tmdb_id: goodShow.tmdb_id,
            poster_path: goodShow.poster_path,
            backdrop_path: goodShow.backdrop_path
          }
        });
      }
    } else if (!goodShow) {
      // Fetch from TMDB
      console.log(`  -> Buscando en TMDB para "${t}"...`);
      const tmdb = await fetchTmdbPoster(t);
      if (tmdb) {
        console.log(`  -> Encontrado en TMDB: ${tmdb.poster_url}`);
        for (const s of shows) {
          await prisma.show.update({
            where: { id: s.id },
            data: {
              poster_url: tmdb.poster_url,
              banner_url: tmdb.banner_url || tmdb.poster_url,
              tmdb_id: tmdb.tmdb_id,
              poster_path: tmdb.poster_path,
              backdrop_path: tmdb.backdrop_path
            }
          });
        }
      }
    }
  }

  // 2. Batch repair all shows using the corrupted sidebar banners
  console.log('\n=== REPARANDO SHOWS CON BANNERS LATERALES DE GNULA ===');
  for (const pattern of CORRUPTED_PATTERNS) {
    const corrupted = await prisma.show.findMany({
      where: { poster_url: { contains: pattern } },
      select: { id: true, title: true, year: true, poster_url: true }
    });

    console.log(`Patrón "${pattern}": ${corrupted.length} shows afectados`);
    for (const c of corrupted) {
      // Look for TMDB match or counterpart
      const counterpart = await prisma.show.findFirst({
        where: {
          title: { equals: c.title, mode: 'insensitive' },
          poster_url: { contains: 'image.tmdb.org' }
        }
      });

      if (counterpart) {
        await prisma.show.update({
          where: { id: c.id },
          data: {
            poster_url: counterpart.poster_url,
            banner_url: counterpart.banner_url || counterpart.poster_url,
            tmdb_id: counterpart.tmdb_id,
            poster_path: counterpart.poster_path,
            backdrop_path: counterpart.backdrop_path
          }
        });
        console.log(`  [Fix por Contraparte] "${c.title}" -> ${counterpart.poster_url}`);
      } else {
        const tmdb = await fetchTmdbPoster(c.title, c.year);
        if (tmdb) {
          await prisma.show.update({
            where: { id: c.id },
            data: {
              poster_url: tmdb.poster_url,
              banner_url: tmdb.banner_url || tmdb.poster_url,
              tmdb_id: tmdb.tmdb_id,
              poster_path: tmdb.poster_path,
              backdrop_path: tmdb.backdrop_path
            }
          });
          console.log(`  [Fix por TMDB] "${c.title}" -> ${tmdb.poster_url}`);
        }
      }
    }
  }

  console.log('\n=== REPARACIÓN DE PÓSTERS COMPLETADA ===');
}

fixPosters().catch(console.error).finally(() => prisma.$disconnect());
