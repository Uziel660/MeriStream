#!/usr/bin/env node
/**
 * Ejecuta la reconciliación de obras/temporadas que comparten identidad TMDB.
 * Por seguridad, sin --apply solo genera un informe y no escribe en la BD.
 */
import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../server/db";
import { reconcileMediaItemsByTmdb, reconcileSequelsByTmdb } from "../server/reconcileCatalog";

function parseArgs() {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  return {
    apply: args.includes("--apply"),
    report: value("--report") || "docs/reports/tmdb-reconcile-latest.json",
  };
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const showSummary = await reconcileSequelsByTmdb({ dryRun: !opts.apply });
  const mediaSummary = await reconcileMediaItemsByTmdb({ dryRun: !opts.apply });
  const summary = { shows: showSummary, media_items: mediaSummary };
  const target = path.resolve(opts.report);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify({ ...summary, report: target }, null, 2));
}

if (!process.env.VITEST && process.argv.some((arg) => arg.endsWith("reconcile-tmdb-seasons.ts"))) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
