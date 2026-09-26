#!/usr/bin/env node
/**
 * Enlaza fichas de idioma de DoramasYT con el MediaItem TMDB que comparte el
 * mismo slug de episodio. Solo aplica cuando la relación es unívoca; nunca
 * inventa un TMDB por similitud de título ni mueve episodios o URLs.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

function episodeVariantKey(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname
      .toLowerCase()
      .replace(/-latino(?=-episodio-)/g, "")
      .replace(/-castellano(?=-episodio-)/g, "");
    return `${parsed.hostname.toLowerCase()}${path}`;
  } catch {
    return String(url || "").toLowerCase();
  }
}

interface ItemRef {
  id: string;
  title: string;
  tmdb_id: number | null;
  kind: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const prisma = new PrismaClient();
  try {
    const links = await prisma.sourceLink.findMany({
      where: { source_site: "doramasyt" },
      select: {
        url: true,
        media_episode: { select: { media_item: { select: { id: true, title: true, tmdb_id: true, kind: true } } } },
      },
    });
    const byKey = new Map<string, Array<{ item: ItemRef; url: string }>>();
    for (const link of links) {
      const item = link.media_episode.media_item;
      const key = episodeVariantKey(link.url);
      const bucket = byKey.get(key) || [];
      bucket.push({ item, url: link.url });
      byKey.set(key, bucket);
    }

    const candidates = new Map<string, { item: ItemRef; tmdbIds: Set<number> }>();
    for (const bucket of byKey.values()) {
      const targets = new Map<number, ItemRef>();
      for (const row of bucket) {
        if (row.item.tmdb_id != null) targets.set(row.item.tmdb_id, row.item);
      }
      if (targets.size !== 1) continue;
      const target = [...targets.values()][0];
      for (const row of bucket) {
        if (row.item.tmdb_id != null || row.item.kind !== target.kind) continue;
        const existing = candidates.get(row.item.id) || { item: row.item, tmdbIds: new Set<number>() };
        existing.tmdbIds.add(target.tmdb_id!);
        candidates.set(row.item.id, existing);
      }
    }

    const safe = [...candidates.values()].filter((entry) => entry.tmdbIds.size === 1);
    let applied = 0;
    if (apply) {
      for (const entry of safe) {
        await prisma.mediaItem.update({
          where: { id: entry.item.id },
          data: { tmdb_id: [...entry.tmdbIds][0] },
        });
        applied++;
      }
    }
    const summary = {
      dryRun: !apply,
      sourceLinksScanned: links.length,
      variantKeys: byKey.size,
      candidates: candidates.size,
      safe: safe.length,
      applied,
      changes: safe.map((entry) => ({ id: entry.item.id, title: entry.item.title, tmdb_id: [...entry.tmdbIds][0] })),
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

export { episodeVariantKey };

