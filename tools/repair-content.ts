import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

const BAD_DESCRIPTION_PATTERNS = [
  /^obra multimedia indexada/i,
  /^importado de/i,
  /^sinopsis no disponible/i,
  /^no description/i,
  /^descripci[oó]n no disponible/i,
  /^n\/a$/i,
  /^描述を検索中/i,
];

async function repairContent() {
  await p.$connect();

  console.log('=== CONTENT REPAIR SCRIPT ===\n');

  const allShows = await p.show.findMany({
    select: { id: true, title: true, description: true, poster_url: true, category: true }
  });

  const badDescShows: Array<{ id: string; title: string; desc: string; reason: string; category: string }> = [];
  const shortDescShows: Array<{ id: string; title: string; desc: string }> = [];
  const noEpShows: Array<{ id: string; title: string; category: string }> = [];
  const singleEpShows: Array<{ id: string; title: string; epCount: number }> = [];
  const badPosterShows: Array<{ id: string; title: string; poster: string }> = [];

  for (const show of allShows) {
    const desc = (show.description || '').trim();

    const isBadDesc = BAD_DESCRIPTION_PATTERNS.some(pat => pat.test(desc));
    if (isBadDesc || desc === '') {
      badDescShows.push({ id: show.id, title: show.title, desc: desc || '(vacío)', reason: 'placeholder', category: show.category });
    } else if (desc.length > 0 && desc.length < 50) {
      shortDescShows.push({ id: show.id, title: show.title, desc });
    }

    if (show.poster_url && !show.poster_url.startsWith('http')) {
      badPosterShows.push({ id: show.id, title: show.title, poster: show.poster_url });
    }
  }

  const showsWithEps = await p.show.findMany({
    select: { id: true, title: true, category: true, _count: { select: { episodes: true } } }
  });

  for (const show of showsWithEps) {
    if (show._count.episodes === 0) {
      noEpShows.push({ id: show.id, title: show.title, category: show.category });
    } else if (show._count.episodes === 1) {
      singleEpShows.push({ id: show.id, title: show.title, epCount: 1 });
    }
  }

  console.log(`Total shows: ${allShows.length}`);
  console.log(`\n--- BAD DESCRIPTIONS ---`);
  console.log(`Placeholder descriptions: ${badDescShows.length}`);
  for (const s of badDescShows.slice(0, 20)) {
    console.log(`  "${s.title}" -> "${s.desc}" [${s.reason}]`);
  }
  if (badDescShows.length > 20) console.log(`  ... and ${badDescShows.length - 20} more`);

  console.log(`\nShort descriptions (<50 chars): ${shortDescShows.length}`);
  for (const s of shortDescShows.slice(0, 10)) {
    console.log(`  "${s.title}" -> "${s.desc}"`);
  }

  console.log(`\n--- EPISODE ISSUES ---`);
  console.log(`Shows with 0 episodes: ${noEpShows.length}`);
  for (const s of noEpShows.slice(0, 20)) {
    console.log(`  "${s.title}" [${s.category}]`);
  }
  if (noEpShows.length > 20) console.log(`  ... and ${noEpShows.length - 20} more`);

  console.log(`\nShows with exactly 1 episode: ${singleEpShows.length}`);

  console.log(`\n--- POSTER ISSUES ---`);
  console.log(`Shows with non-HTTP poster URLs: ${badPosterShows.length}`);
  for (const s of badPosterShows) {
    console.log(`  "${s.title}" -> "${s.poster}"`);
  }

  console.log(`\n--- ATTEMPTING REPAIRS ---`);

  let repaired = 0;
  let failed = 0;

  for (const show of badDescShows.slice(0, 50)) {
    try {
      const { enrichUniversalMetadata } = await import('../server/metadataEngine');
      const enriched = await enrichUniversalMetadata(show.title, show.category as any);

      if (enriched && enriched.description && enriched.description.length > 50) {
        await p.show.update({
          where: { id: show.id },
          data: { description: enriched.description }
        });
        console.log(`  REPAIRED: "${show.title}" -> "${enriched.description.substring(0, 80)}..."`);
        repaired++;
      } else {
        console.log(`  FAILED (no good description): "${show.title}"`);
        failed++;
      }

      await new Promise(r => setTimeout(r, 2000));
    } catch (e: any) {
      console.log(`  ERROR: "${show.title}" -> ${e.message}`);
      failed++;
    }
  }

  console.log(`\n--- SUMMARY ---`);
  console.log(`Repaired: ${repaired}`);
  console.log(`Failed: ${failed}`);
  console.log(`Remaining bad descriptions: ${badDescShows.length - repaired}`);

  await p.$disconnect();
}

repairContent().catch(console.error);
