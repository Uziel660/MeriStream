import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

const BATCH_SIZE = 45; // Parallel requests per batch
const DELAY_BETWEEN_BATCHES = 1000; // 1s between batches

const BAD_DESCRIPTION_PATTERNS = [
  /^obra multimedia indexada/i,
  /^importado de/i,
  /^sinopsis no disponible/i,
  /^no description/i,
  /^descripci[oó]n no disponible/i,
  /^n\/a$/i,
  /^描述を検索中/i,
];

async function repairBulk() {
  await p.$connect();
  const start = Date.now();

  console.log('=== BULK CONTENT REPAIR ===\n');

  // 1. Find ALL shows with bad descriptions
  const allShows = await p.show.findMany({
    select: { id: true, title: true, description: true, category: true }
  });

  const needsRepair: Array<{ id: string; title: string; category: string }> = [];

  for (const show of allShows) {
    const desc = (show.description || '').trim();
    const isBad = BAD_DESCRIPTION_PATTERNS.some(p => p.test(desc)) || desc === '' || (desc.length > 0 && desc.length < 50);
    if (isBad) {
      needsRepair.push({ id: show.id, title: show.title, category: show.category });
    }
  }

  console.log(`Total shows: ${allShows.length}`);
  console.log(`Need repair: ${needsRepair.length}`);
  console.log(`Batch size: ${BATCH_SIZE} parallel requests`);
  console.log(`Estimated time: ~${Math.ceil(needsRepair.length / BATCH_SIZE * 2)} seconds\n`);

  // 2. Clear ALL bad descriptions immediately
  console.log('--- PHASE 1: Clearing bad descriptions ---');
  const idsToClear = needsRepair.map(s => s.id);

  // Batch update in chunks of 500
  for (let i = 0; i < idsToClear.length; i += 500) {
    const chunk = idsToClear.slice(i, i + 500);
    await p.show.updateMany({
      where: { id: { in: chunk } },
      data: { description: '' }
    });
    console.log(`  Cleared ${Math.min(i + 500, idsToClear.length)}/${idsToClear.length} descriptions`);
  }

  // 3. Re-enrich in parallel batches
  console.log('\n--- PHASE 2: Re-enriching from APIs ---');
  const { enrichUniversalMetadata } = await import('../server/metadataEngine');

  let repaired = 0;
  let failed = 0;

  for (let i = 0; i < needsRepair.length; i += BATCH_SIZE) {
    const batch = needsRepair.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(needsRepair.length / BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (show) => {
        try {
          const enriched = await enrichUniversalMetadata(show.title, show.category as any);
          if (enriched && enriched.description && enriched.description.length > 50) {
            await p.show.update({
              where: { id: show.id },
              data: { description: enriched.description }
            });
            return { ok: true, title: show.title };
          }
          return { ok: false, title: show.title, reason: 'no good description' };
        } catch (e: any) {
          return { ok: false, title: show.title, reason: e.message };
        }
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.ok) repaired++;
      else failed++;
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  Batch ${batchNum}/${totalBatches} done (${elapsed}s) - OK: ${repaired} / FAIL: ${failed}`);

    if (i + BATCH_SIZE < needsRepair.length) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES));
    }
  }

  // 4. Summary
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n=== SUMMARY ===`);
  console.log(`Total processed: ${needsRepair.length}`);
  console.log(`Repaired: ${repaired}`);
  console.log(`Failed: ${failed}`);
  console.log(`Time: ${elapsed}s`);

  // 5. Verify
  const remaining = await p.show.count({
    where: {
      OR: [
        { description: '' },
        { description: { startsWith: 'Obra multimedia indexada' } },
      ]
    }
  });
  console.log(`Remaining bad descriptions: ${remaining}`);

  await p.$disconnect();
}

repairBulk().catch(console.error);
