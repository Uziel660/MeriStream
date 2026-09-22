#!/usr/bin/env node
/**
 * Completa canonical_locator en páginas/embeds ya guardados.
 * Es idempotente: no transforma directos firmados ni sobrescribe valores.
 */
import "dotenv/config";
import { prisma } from "../server/db";
import { isCanonicalLocator, isExcludedRecoverySite } from "../server/sourceRecoveryWorker";

function parseArgs(): { apply: boolean; limit?: number; concurrency: number } {
  const args = process.argv.slice(2);
  const valueAfter = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const rawLimit = Number(valueAfter("--limit"));
  const rawConcurrency = Number(valueAfter("--concurrency"));
  return {
    apply: args.includes("--apply"),
    limit: Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : undefined,
    concurrency: Number.isInteger(rawConcurrency) && rawConcurrency > 0 ? Math.min(8, rawConcurrency) : 4,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const rows = await prisma.sourceLink.findMany({
    where: { link_type: { in: ["page", "embed"] }, canonical_locator: null },
    select: { id: true, url: true, source_site: true },
    orderBy: { id: "asc" },
    take: opts.limit,
  });
  const candidates = rows.filter((row) =>
    !isExcludedRecoverySite(row.source_site) &&
    !isExcludedRecoverySite(row.url) &&
    isCanonicalLocator(row.url),
  );
  let updated = 0;
  if (opts.apply) {
    for (let index = 0; index < candidates.length; index += opts.concurrency) {
      const batch = candidates.slice(index, index + opts.concurrency);
      const results = await Promise.all(batch.map((row) => prisma.sourceLink.updateMany({
        where: { id: row.id, canonical_locator: null },
        data: { canonical_locator: row.url },
      })));
      updated += results.reduce((sum, result) => sum + result.count, 0);
      if ((index + batch.length) % 500 < opts.concurrency || index + batch.length === candidates.length) {
        console.log(`[CanonicalBackfill] ${index + batch.length}/${candidates.length}`);
      }
    }
  }
  console.log(JSON.stringify({
    dry_run: !opts.apply,
    scanned: rows.length,
    candidates: candidates.length,
    updated,
    excluded_or_noncanonical: rows.length - candidates.length,
  }, null, 2));
}

if (!process.env.VITEST && process.argv.some((arg) => arg.endsWith("backfill-canonical-locators.ts"))) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  }).finally(async () => {
    await prisma.$disconnect();
  });
}
