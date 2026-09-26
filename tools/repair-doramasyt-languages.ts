#!/usr/bin/env node
/**
 * Corrige únicamente la representación de idioma de las fuentes DoramasYT.
 *
 * DoramasYT añade `sub-espanol` también a sus fichas dobladas, por eso el
 * sufijo del episodio es la señal fiable. Este script no cambia TMDB,
 * MediaItem, MediaEpisode ni las URLs: solo actualiza language/audio_language/
 * subtitle_language en SourceLink. Por defecto es dry-run.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

type Rendition = "latino" | "castellano" | "sub" | "unknown";

export function classifyDoramasytUrl(url: string): Rendition {
  const value = String(url || "").toLowerCase();
  if (/-latino-episodio-\d+(?:[/?#]|$)/i.test(value)) return "latino";
  if (/-castellano-episodio-\d+(?:[/?#]|$)/i.test(value)) return "castellano";
  if (/-episodio-\d+(?:[/?#]|$)/i.test(value)) return "sub";
  return "unknown";
}

function parseArgs() {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  return { apply: args.includes("--apply"), report: value("--report") };
}

async function writeReport(target: string | undefined, payload: unknown): Promise<void> {
  if (!target) return;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const absolute = path.resolve(target);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, JSON.stringify(payload, null, 2), "utf8");
}

async function counts(prisma: PrismaClient): Promise<Record<Rendition, number> & { total: number }> {
  const rows = await prisma.$queryRawUnsafe<Array<{ rendition: Rendition; count: bigint }>>(`
    SELECT CASE
      WHEN url ILIKE '%-latino-episodio-%' THEN 'latino'
      WHEN url ILIKE '%-castellano-episodio-%' THEN 'castellano'
      WHEN url ILIKE '%-episodio-%' THEN 'sub'
      ELSE 'unknown'
    END AS rendition,
    COUNT(*)::bigint AS count
    FROM "SourceLink"
    WHERE source_site = 'doramasyt'
    GROUP BY 1;
  `);
  const result: Record<Rendition, number> & { total: number } = {
    latino: 0,
    castellano: 0,
    sub: 0,
    unknown: 0,
    total: 0,
  };
  for (const row of rows) {
    const key = row.rendition in result ? row.rendition : "unknown";
    result[key] = Number(row.count || 0);
    result.total += Number(row.count || 0);
  }
  return result;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const prisma = new PrismaClient();
  try {
    const before = await counts(prisma);
    const changedBefore = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`
      SELECT COUNT(*)::bigint AS count
      FROM "SourceLink"
      WHERE source_site = 'doramasyt'
        AND (
          (url ILIKE '%-latino-episodio-%' AND (language IS DISTINCT FROM 'dub' OR audio_language IS DISTINCT FROM 'es-419' OR subtitle_language IS NOT NULL))
          OR (url ILIKE '%-castellano-episodio-%' AND (language IS DISTINCT FROM 'dub' OR audio_language IS DISTINCT FROM 'es-ES' OR subtitle_language IS NOT NULL))
          OR (url NOT ILIKE '%-latino-episodio-%' AND url NOT ILIKE '%-castellano-episodio-%' AND url ILIKE '%-episodio-%' AND (language IS DISTINCT FROM 'sub' OR audio_language IS NOT NULL OR subtitle_language IS DISTINCT FROM 'es'))
        );
    `);
    const changed = Number(changedBefore[0]?.count || 0);

    if (opts.apply) {
      await prisma.$transaction([
        prisma.$executeRawUnsafe(`
          UPDATE "SourceLink"
          SET language = 'dub', audio_language = 'es-419', subtitle_language = NULL
          WHERE source_site = 'doramasyt' AND url ILIKE '%-latino-episodio-%';
        `),
        prisma.$executeRawUnsafe(`
          UPDATE "SourceLink"
          SET language = 'dub', audio_language = 'es-ES', subtitle_language = NULL
          WHERE source_site = 'doramasyt' AND url ILIKE '%-castellano-episodio-%';
        `),
        prisma.$executeRawUnsafe(`
          UPDATE "SourceLink"
          SET language = 'sub', audio_language = NULL, subtitle_language = 'es'
          WHERE source_site = 'doramasyt'
            AND url NOT ILIKE '%-latino-episodio-%'
            AND url NOT ILIKE '%-castellano-episodio-%'
            AND url ILIKE '%-episodio-%';
        `),
      ]);
    }

    const after = await counts(prisma);
    const remaining = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`
      SELECT COUNT(*)::bigint AS count
      FROM "SourceLink"
      WHERE source_site = 'doramasyt'
        AND (
          (url ILIKE '%-latino-episodio-%' AND (language IS DISTINCT FROM 'dub' OR audio_language IS DISTINCT FROM 'es-419' OR subtitle_language IS NOT NULL))
          OR (url ILIKE '%-castellano-episodio-%' AND (language IS DISTINCT FROM 'dub' OR audio_language IS DISTINCT FROM 'es-ES' OR subtitle_language IS NOT NULL))
          OR (url NOT ILIKE '%-latino-episodio-%' AND url NOT ILIKE '%-castellano-episodio-%' AND url ILIKE '%-episodio-%' AND (language IS DISTINCT FROM 'sub' OR audio_language IS NOT NULL OR subtitle_language IS DISTINCT FROM 'es'))
        );
    `);
    const summary = {
      dryRun: !opts.apply,
      changed,
      remaining: Number(remaining[0]?.count || 0),
      before,
      after,
      sourceLinksPreserved: before.total === after.total,
    };
    await writeReport(opts.report, { generatedAt: new Date().toISOString(), summary });
    console.log(JSON.stringify(summary, null, 2));
    if (!opts.apply) console.log("Dry-run: usa --apply para escribir únicamente metadata DoramasYT.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

