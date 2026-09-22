#!/usr/bin/env node
/**
 * Normaliza SourceLink.source_site a los IDs canónicos del registro de
 * proveedores. Por defecto solo audita; --apply actualiza aliases de host y
 * fusiona duplicados exactos sin tocar la URL ni el episodio relacionado.
 */
import "dotenv/config";
import { prisma } from "../server/db";
import { getProviderPolicy, normalizeProviderId } from "../server/providers/providerPolicy";

function parseApply(): boolean {
  return process.argv.slice(2).includes("--apply");
}

async function main(): Promise<void> {
  const apply = parseApply();
  const groups = await prisma.sourceLink.groupBy({ by: ["source_site"], _count: { _all: true } });
  let aliases = 0;
  let renamed = 0;
  let merged = 0;
  let skipped = 0;
  const details: Array<{ from: string; to: string; links: number; renamed: number; merged: number }> = [];

  for (const group of groups) {
    const from = group.source_site;
    const to = normalizeProviderId(from);
    if (to === from || !getProviderPolicy(to)) {
      skipped++;
      continue;
    }
    aliases++;
    const rows = apply ? null : await prisma.sourceLink.findMany({
      where: { source_site: from },
      select: { id: true, media_episode_id: true, url: true },
    });
    let groupRenamed = 0;
    let groupMerged = 0;
    if (apply) {
      // Hacerlo en dos operaciones SQL por alias evita una consulta por enlace
      // en PostgreSQL remoto. El DELETE solo afecta duplicados exactos:
      // mismo episodio, mismo proveedor canónico y misma URL.
      await prisma.$transaction(async (tx) => {
        groupMerged = await tx.$executeRawUnsafe(
          `DELETE FROM "SourceLink" AS alias
           USING "SourceLink" AS canonical
           WHERE alias."source_site" = $1
             AND canonical."source_site" = $2
             AND alias."media_episode_id" = canonical."media_episode_id"
             AND alias."url" = canonical."url"`,
          from,
          to,
        );
        groupRenamed = await tx.$executeRawUnsafe(
          `UPDATE "SourceLink" SET "source_site" = $2 WHERE "source_site" = $1`,
          from,
          to,
        );
      });
    } else {
      for (const row of rows || []) {
        const canonical = await prisma.sourceLink.findUnique({
          where: {
            media_episode_id_source_site_url: {
              media_episode_id: row.media_episode_id,
              source_site: to,
              url: row.url,
            },
          },
          select: { id: true },
        });
        if (canonical) groupMerged++;
        else groupRenamed++;
      }
    }
    renamed += groupRenamed;
    merged += groupMerged;
    details.push({ from, to, links: group.source_site ? Number(group._count._all) : 0, renamed: groupRenamed, merged: groupMerged });
  }

  console.log(JSON.stringify({ dry_run: !apply, aliases, renamed, merged, skipped, details }, null, 2));
}

main().finally(() => prisma.$disconnect());
