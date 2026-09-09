#!/usr/bin/env node
/** Verifica que cada obra tenga al menos una identidad externa confiable. */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getCatalogIdentityException } from "./catalogIdentityExceptions";

const PRIMARY_SOURCES = ["cinecalidad", "latanime", "gnula", "tioanime"];

function args() {
  const argv = process.argv.slice(2);
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    primaryOnly: argv.includes("--primary-only"),
    strict: argv.includes("--strict"),
    report: value("--report"),
  };
}

async function main() {
  const options = args();
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.show.findMany({
      where: options.primaryOnly ? { source: { in: PRIMARY_SOURCES } } : undefined,
      orderBy: { id: "asc" },
      select: {
        id: true,
        title: true,
        category: true,
        year: true,
        source: true,
        tmdb_id: true,
        mal_id: true,
        anilist_id: true,
        _count: { select: { episodes: true } },
      },
    });
    const missing = rows.filter((row) => !row.tmdb_id && !row.mal_id && !row.anilist_id);
    const exceptions = missing
      .map((row) => ({ row, exception: getCatalogIdentityException(row.title) }))
      .filter((value): value is { row: (typeof rows)[number]; exception: NonNullable<ReturnType<typeof getCatalogIdentityException>> } => Boolean(value.exception));
    const actionableMissing = missing.filter((row) => !getCatalogIdentityException(row.title));
    const invalid = rows.filter((row) =>
      (row.tmdb_id !== null && (!Number.isInteger(row.tmdb_id) || row.tmdb_id <= 0))
      || (row.mal_id !== null && (!Number.isInteger(row.mal_id) || row.mal_id <= 0))
      || (row.anilist_id !== null && !/^\d+$/.test(row.anilist_id)),
    );
    const identityFieldCoverage = (group: typeof rows) => ({
      total: group.length,
      tmdb: group.filter((row) => row.tmdb_id !== null).length,
      mal: group.filter((row) => row.mal_id !== null).length,
      anilist: group.filter((row) => row.anilist_id !== null).length,
      allThree: group.filter((row) => row.tmdb_id !== null && row.mal_id !== null && row.anilist_id !== null).length,
      any: group.filter((row) => row.tmdb_id !== null || row.mal_id !== null || row.anilist_id !== null).length,
    });
    const result = {
      generatedAt: new Date().toISOString(),
      scope: options.primaryOnly ? "primary-providers" : "all-sources",
      total: rows.length,
      covered: rows.length - missing.length,
      missing: missing.length,
      actionableMissing: actionableMissing.length,
      exceptions: exceptions.map(({ row, exception }) => ({ ...row, ...exception })),
      invalid: invalid.length,
      identityFieldCoverage: identityFieldCoverage(rows),
      byCategory: Object.fromEntries([...new Set(rows.map((row) => row.category))].map((category) => {
        const group = rows.filter((row) => row.category === category);
        return [category, {
          ...identityFieldCoverage(group),
          covered: group.filter((row) => row.tmdb_id || row.mal_id || row.anilist_id).length,
          missing: group.filter((row) => !row.tmdb_id && !row.mal_id && !row.anilist_id).length,
        }];
      })),
      bySource: Object.fromEntries([...new Set(rows.map((row) => row.source || "unknown"))].map((source) => {
        const group = rows.filter((row) => (row.source || "unknown") === source);
        const missingGroup = group.filter((row) => !row.tmdb_id && !row.mal_id && !row.anilist_id);
        return [source, {
          ...identityFieldCoverage(group),
          covered: group.length - missingGroup.length,
          missing: missingGroup.length,
          withEpisodes: group.filter((row) => row._count.episodes > 0).length,
          withoutEpisodes: group.filter((row) => row._count.episodes === 0).length,
          missingWithEpisodes: missingGroup.filter((row) => row._count.episodes > 0).length,
          missingWithoutEpisodes: missingGroup.filter((row) => row._count.episodes === 0).length,
        }];
      })),
      missingRows: missing,
      invalidRows: invalid,
    };
    if (options.report) {
      const target = path.resolve(options.report);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(result, null, 2), "utf8");
    }
    console.log(JSON.stringify(result, null, 2));
    if (options.strict && (actionableMissing.length || invalid.length)) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`[verify-catalog-identities] ${String(error)}`);
  process.exitCode = 1;
});
