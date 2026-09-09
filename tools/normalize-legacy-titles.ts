#!/usr/bin/env node
/**
 * Limpia entidades HTML que quedaron persistidas por scrapers legacy.
 *
 * Es una pasada deliberadamente estrecha: solo cambia `title` y
 * `normalized_title` en Show/MediaItem. No elimina filas ni toca episodios,
 * URLs, source, metadata externa o identificadores ya reparados.
 *
 * Por defecto audita. Usa --apply para persistir los cambios.
 */
import "dotenv/config";
import { prisma } from "../server/db";
import { decodeHtmlEntities, normalizeTitleKey } from "../server/utils/titleNormalizer";

function cleanTitle(value: string): string {
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes("--apply");
  const [shows, mediaItems] = await Promise.all([
    prisma.show.findMany({ select: { id: true, title: true, normalized_title: true } }),
    prisma.mediaItem.findMany({ select: { id: true, title: true, normalized_title: true, kind: true, year: true } }),
  ]);

  const showChanges = shows
    .map((row) => ({
      ...row,
      title: cleanTitle(row.title),
      normalized_title: normalizeTitleKey(cleanTitle(row.title)),
    }))
    .filter((row, index) => row.title !== shows[index].title || row.normalized_title !== shows[index].normalized_title);
  const mediaKeys = new Set(mediaItems.map((row) => `${row.normalized_title}\u0000${row.kind}\u0000${row.year ?? ""}`));
  const desiredCounts = new Map<string, number>();
  for (const row of mediaItems) {
    const desired = normalizeTitleKey(cleanTitle(row.title));
    const key = `${desired}\u0000${row.kind}\u0000${row.year ?? ""}`;
    desiredCounts.set(key, (desiredCounts.get(key) || 0) + 1);
  }
  let mediaItemConflicts = 0;
  const mediaChanges = mediaItems
    .map((row) => {
      const desiredNormalizedTitle = normalizeTitleKey(cleanTitle(row.title));
      const desiredKey = `${desiredNormalizedTitle}\u0000${row.kind}\u0000${row.year ?? ""}`;
      const conflicts = desiredNormalizedTitle !== row.normalized_title && (
        (mediaKeys.has(desiredKey) && desiredKey !== `${row.normalized_title}\u0000${row.kind}\u0000${row.year ?? ""}`)
        || (desiredCounts.get(desiredKey) || 0) > 1
      );
      if (conflicts) mediaItemConflicts++;
      return {
      ...row,
      title: cleanTitle(row.title),
      normalized_title: conflicts ? row.normalized_title : desiredNormalizedTitle,
      };
    })
    .filter((row, index) => row.title !== mediaItems[index].title || row.normalized_title !== mediaItems[index].normalized_title);

  if (apply) {
    await prisma.$transaction([
      ...showChanges.map((row) => prisma.show.update({
        where: { id: row.id },
        data: { title: row.title, normalized_title: row.normalized_title },
      })),
      ...mediaChanges.map((row) => prisma.mediaItem.update({
        where: { id: row.id },
        data: { title: row.title, normalized_title: row.normalized_title },
      })),
    ]);
  }

  console.log(JSON.stringify({
    dry_run: !apply,
    shows_scanned: shows.length,
    media_items_scanned: mediaItems.length,
    show_changes: showChanges.length,
    media_item_changes: mediaChanges.length,
    media_item_normalized_conflicts: mediaItemConflicts,
    changed_rows: showChanges.length + mediaChanges.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(`[normalize-legacy-titles] ${String(error)}`);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
