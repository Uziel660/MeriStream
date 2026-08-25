import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

(async () => {
  await p.$connect();

  const total = await p.show.count();
  console.log(`\n=== AUDITORÍA DE CONTENIDO (${total} shows) ===\n`);

  // 1. Shows with placeholder/generic descriptions
  const placeholderDesc = await p.show.count({
    where: {
      description: {
        in: ["", "Sinopsis no disponible", "N/A", "Descripción no disponible", "No description available"]
      }
    }
  });
  console.log(`Descripciones placeholder/vacías: ${placeholderDesc} (${Math.round(placeholderDesc/total*100)}%)`);

  // 2. Shows with very short descriptions (<50 chars)
  const shortDesc = await p.$queryRawUnsafe(`
    SELECT COUNT(*)::int as count FROM "Show"
    WHERE LENGTH(description) < 50 AND description != ''
  `) as any[];
  console.log(`Descripciones muy cortas (<50 chars): ${shortDesc[0].count} (${Math.round(shortDesc[0].count/total*100)}%)`);

  // 3. Poster quality check - shows with poster_url that's not a valid URL
  const badPoster = await p.$queryRawUnsafe(`
    SELECT COUNT(*)::int as count FROM "Show"
    WHERE poster_url IS NOT NULL
    AND poster_url NOT LIKE 'http%'
    AND poster_url != ''
  `) as any[];
  console.log(`Posters con URL inválida: ${badPoster[0].count}`);

  // 4. Shows with 0 episodes
  const noEps = await p.show.count({ where: { episodes: { none: {} } } });
  console.log(`Shows sin episodios: ${noEps} (${Math.round(noEps/total*100)}%)`);

  // 5. Shows with episodes but ALL episodes have empty source_url
  const epsNoSource = await p.$queryRawUnsafe(`
    SELECT COUNT(DISTINCT s.id)::int as count FROM "Show" s
    INNER JOIN "Episode" e ON e.show_id = s.id
    WHERE (e.source_url IS NULL OR e.source_url = '')
  `) as any[];
  console.log(`Shows con episodios sin fuente: ${epsNoSource[0].count}`);

  // 6. Sample 10 RECENTLY created shows with their data quality
  const recent = await p.show.findMany({
    orderBy: { created_at: "desc" },
    take: 10,
    select: {
      title: true,
      description: true,
      poster_url: true,
      backdrop_path: true,
      category: true,
      created_at: true,
      _count: { select: { episodes: true } }
    }
  });
  console.log(`\n=== 10 SHOWS MÁS RECIENTES ===`);
  for (const s of recent) {
    const descPreview = (s.description || '').substring(0, 80);
    const posterOk = s.poster_url?.startsWith('http');
    console.log(`\n  "${s.title}" [${s.category}]`);
    console.log(`    Poster: ${posterOk ? '✓' : '✗'} ${(s.poster_url || 'null').substring(0, 60)}`);
    console.log(`    Backdrop: ${s.backdrop_path ? '✓' : '✗'}`);
    console.log(`    Descripción: ${descPreview || 'VACÍA'}...`);
    console.log(`    Episodios: ${s._count.episodes}`);
  }

  // 7. Sample 10 shows with MOST episodes
  const biggest = await p.$queryRawUnsafe(`
    SELECT s.title, s.category, COUNT(e.id)::int as ep_count,
           s.description, s.poster_url
    FROM "Show" s
    INNER JOIN "Episode" e ON e.show_id = s.id
    GROUP BY s.id
    ORDER BY ep_count DESC
    LIMIT 10
  `) as any[];
  console.log(`\n=== TOP 10 SHOWS POR EPISODIOS ===`);
  for (const s of biggest) {
    console.log(`  "${s.title}" [${s.category}] - ${s.ep_count} eps - Poster: ${s.poster_url ? '✓' : '✗'}`);
  }

  // 8. SourceLinks stats
  const sl = await p.sourceLink.count();
  const mi = await p.mediaItem.count();
  console.log(`\nMediaItems: ${mi}, SourceLinks: ${sl}`);

  // 9. Episodes with source_url by category
  const byCat = await p.$queryRawUnsafe(`
    SELECT s.category, COUNT(DISTINCT s.id)::int as shows,
           COUNT(e.id)::int as episodes,
           COUNT(CASE WHEN e.source_url IS NOT NULL AND e.source_url != '' THEN 1 END)::int as eps_with_source
    FROM "Show" s
    LEFT JOIN "Episode" e ON e.show_id = s.id
    GROUP BY s.category
    ORDER BY shows DESC
  `) as any[];
  console.log(`\n=== POR CATEGORÍA ===`);
  for (const c of byCat) {
    console.log(`  ${c.category}: ${c.shows} shows, ${c.episodes} eps (${c.eps_with_source} con fuente)`);
  }

  await p.$disconnect();
})();
