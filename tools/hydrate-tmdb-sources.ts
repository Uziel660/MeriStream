#!/usr/bin/env node
import "dotenv/config";
import { prisma } from "../server/db";
import { resolveByTmdb, type GatewayKind } from "../server/providerGateway";

function intFlag(name: string, fallback: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const CONCURRENCY = Math.min(64, intFlag("concurrency", 16));
const LIMIT = intFlag("limit", Number.MAX_SAFE_INTEGER);
const DRY = process.argv.includes("--dry");

async function main() {
  const episodes = await prisma.mediaEpisode.findMany({
    where: { media_item: { tmdb_id: { not: null } } },
    select: {
      season_number: true,
      episode_number: true,
      media_item: { select: { tmdb_id: true, kind: true, title: true } },
    },
    orderBy: { created_at: "asc" },
    take: LIMIT,
  });

  console.log(`[hydrate] episodes=${episodes.length} concurrency=${CONCURRENCY} dry=${DRY}`);
  let cursor = 0;
  let completed = 0;
  let withSources = 0;
  let persisted = 0;
  let failures = 0;

  async function worker(workerId: number) {
    while (true) {
      const index = cursor++;
      if (index >= episodes.length) return;
      const row = episodes[index];
      const tmdbId = row.media_item.tmdb_id;
      if (!tmdbId) continue;
      const kind = row.media_item.kind as GatewayKind;
      if (!(["movie", "series", "anime"] as string[]).includes(kind)) continue;
      try {
        const result = await resolveByTmdb({
          tmdbId,
          kind,
          season: kind === "movie" ? 1 : row.season_number,
          episode: kind === "movie" ? 1 : Math.trunc(row.episode_number),
          persist: !DRY,
        });
        completed++;
        persisted += result.persisted;
        if (result.sources.length > 0) withSources++;
        if (completed % 50 === 0 || completed === episodes.length) {
          console.log(`[hydrate] ${completed}/${episodes.length} withSources=${withSources} persisted=${persisted} failures=${failures}`);
        }
      } catch (error) {
        failures++;
        if (failures <= 20) console.warn(`[hydrate:${workerId}] ${row.media_item.title}:`, error);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));
  console.log(JSON.stringify({ completed, withSources, persisted, failures }, null, 2));
}

main()
  .catch((error) => { console.error("[hydrate] fatal:", error); process.exitCode = 1; })
  .finally(async () => prisma.$disconnect());
