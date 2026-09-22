#!/usr/bin/env node
/**
 * Rellena imdb_id y tvdb_id para todas las obras que ya cuentan con un tmdb_id
 * pero carecen de identificador IMDb.
 *
 * - Por defecto corre en modo dry-run. Usa --apply para guardar en PostgreSQL.
 * - Concurrencia controlada con manejo de rate-limits de TMDB.
 * - Sincroniza tanto la tabla Show como MediaItem.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const prisma = new PrismaClient();
const TMDB_API_KEY = process.env.TMDB_API_KEY || "4598f607660f5c4eb423d868da148981";

interface Options {
  apply: boolean;
  limit: number;
  concurrency: number;
  report?: string;
}

function parseArgs(): Options {
  const argv = process.argv.slice(2);
  const value = (name: string) => {
    const idx = argv.indexOf(name);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  return {
    apply: argv.includes("--apply"),
    limit: Number(value("--limit")) || 0,
    concurrency: Math.min(30, Math.max(1, Number(value("--concurrency")) || 12)),
    report: value("--report"),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchTmdbExternalIds(tmdbId: number, category: string): Promise<{ imdbId: string | null; tvdbId: number | null }> {
  const isMovie = category === "movie";
  const types = isMovie ? ["movie", "tv"] : ["tv", "movie"];

  for (const type of types) {
    const url = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
      if (res.status === 429) {
        await sleep(1500);
        return fetchTmdbExternalIds(tmdbId, category);
      }
      if (!res.ok) continue;
      const data = await res.json();
      const ext = data.external_ids || {};
      const rawImdb = (data.imdb_id || ext.imdb_id || "").trim();
      const imdbId = /^tt\d{5,12}$/i.test(rawImdb) ? rawImdb : null;
      const tvdbId = typeof ext.tvdb_id === "number" && ext.tvdb_id > 0 ? ext.tvdb_id : null;
      return { imdbId, tvdbId };
    } catch {
      // Timeout o error de red puntual
    }
  }
  return { imdbId: null, tvdbId: null };
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const opts = parseArgs();
  console.log(`[backfill-imdb-ids] Iniciando con apply=${opts.apply}, concurrency=${opts.concurrency}, limit=${opts.limit || 'sin límite'}`);

  const whereClause = {
    tmdb_id: { not: null },
    imdb_id: null,
  };

  const totalCandidates = await prisma.show.count({ where: whereClause });
  console.log(`[backfill-imdb-ids] Total de obras con tmdb_id y sin imdb_id: ${totalCandidates}`);

  const shows = await prisma.show.findMany({
    where: whereClause,
    take: opts.limit > 0 ? opts.limit : undefined,
    orderBy: { id: "asc" },
    select: { id: true, title: true, tmdb_id: true, category: true, year: true },
  });

  console.log(`[backfill-imdb-ids] Procesando ${shows.length} obras en lote...`);

  let recoveredImdb = 0;
  let recoveredTvdb = 0;
  let appliedCount = 0;
  let notFoundCount = 0;
  const sampleUpdates: any[] = [];

  const startMs = Date.now();

  await mapConcurrent(shows, opts.concurrency, async (show, idx) => {
    const { imdbId, tvdbId } = await fetchTmdbExternalIds(show.tmdb_id!, show.category);

    if (imdbId) recoveredImdb++;
    if (tvdbId) recoveredTvdb++;

    if (!imdbId && !tvdbId) {
      notFoundCount++;
    } else {
      if (sampleUpdates.length < 20) {
        sampleUpdates.push({ title: show.title, tmdb_id: show.tmdb_id, imdb_id: imdbId, tvdb_id: tvdbId });
      }

      if (opts.apply) {
        const updateData: any = {};
        if (imdbId) updateData.imdb_id = imdbId;
        if (tvdbId) updateData.tvdb_id = tvdbId;

        await prisma.show.update({
          where: { id: show.id },
          data: updateData,
        });

        // Actualizar también MediaItem si comparte el mismo tmdb_id
        await prisma.mediaItem.updateMany({
          where: { tmdb_id: show.tmdb_id, imdb_id: null },
          data: updateData,
        });

        appliedCount++;
      }
    }

    if ((idx + 1) % 50 === 0 || idx + 1 === shows.length) {
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      const rate = ((idx + 1) / (Number(elapsed) || 1)).toFixed(1);
      console.log(`[backfill-imdb-ids] Progreso: ${idx + 1}/${shows.length} (${((idx + 1) / shows.length * 100).toFixed(1)}%) | IMDb encontrados: ${recoveredImdb} | ${rate} req/s`);
    }
  });

  const summary = {
    totalConsidered: shows.length,
    recoveredImdb,
    recoveredTvdb,
    notFoundCount,
    applied: opts.apply ? appliedCount : 0,
    dryRun: !opts.apply,
    durationSec: ((Date.now() - startMs) / 1000).toFixed(1),
    samples: sampleUpdates,
  };

  console.log("\n=== RESUMEN FINAL ===");
  console.log(JSON.stringify(summary, null, 2));

  if (opts.report) {
    await mkdir(path.dirname(opts.report), { recursive: true });
    await writeFile(opts.report, JSON.stringify(summary, null, 2), "utf8");
    console.log(`[backfill-imdb-ids] Reporte guardado en ${opts.report}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[backfill-imdb-ids] Error crítico:", err);
  process.exit(1);
});
