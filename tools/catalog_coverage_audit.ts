/** Snapshot de cobertura de la fusión multi-fuente. Solo lectura. */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../server/db";

interface ProviderCount { provider: string; links: number; episodes: number; }
interface DuplicateItem { id: string; title: string; year: number | null; kind: string; episodes: number; providers: string[]; links: number; }

async function main(): Promise<void> {
  let mediaEpisodes = 0;
  let episodesWithoutLinks = 0;
  let episodesWithMultipleSites = 0;
  let mediaItemsTotal = 0;
  const providerLinks = new Map<string, number>();
  const providerEpisodes = new Map<string, number>();
  const kindTotals = new Map<string, { items: number; episodes: number; linked: number }>();
  const duplicateBuckets = new Map<string, DuplicateItem[]>();
  const batchSize = 500;
  let lastMediaItemId: string | undefined;

  // Procesar por lotes evita materializar cientos de miles de enlaces en RAM.
  // El cursor por id mantiene el recorrido estable y permite ejecutar esta
  // auditoría en el servidor futuro con mucha menos memoria.
  for (;;) {
    const items = await prisma.mediaItem.findMany({
      take: batchSize,
      ...(lastMediaItemId ? { skip: 1, cursor: { id: lastMediaItemId } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        title: true,
        normalized_title: true,
        base_normalized_title: true,
        kind: true,
        year: true,
        episodes: { select: { links: { select: { source_site: true } } } },
      },
    });
    if (items.length === 0) break;
    mediaItemsTotal += items.length;

    for (const item of items) {
      const kind = item.kind || "unknown";
      const kindTotal = kindTotals.get(kind) || { items: 0, episodes: 0, linked: 0 };
      kindTotal.items++;
      kindTotal.episodes += item.episodes.length;
      kindTotal.linked += item.episodes.filter((episode) => episode.links.length > 0).length;
      kindTotals.set(kind, kindTotal);

      const duplicateKey = `${item.normalized_title}\u0000${kind}\u0000${item.year ?? ""}`;
      const bucket = duplicateBuckets.get(duplicateKey) || [];
      bucket.push({
        id: item.id,
        title: item.title,
        year: item.year,
        kind,
        episodes: item.episodes.length,
        providers: [...new Set(item.episodes.flatMap((episode) => episode.links.map((link) => link.source_site || "unknown")))],
        links: item.episodes.reduce((sum, episode) => sum + episode.links.length, 0),
      });
      duplicateBuckets.set(duplicateKey, bucket);

      for (const episode of item.episodes) {
        mediaEpisodes++;
        const sites = new Set(episode.links.map((link) => link.source_site || "unknown"));
        if (sites.size === 0) episodesWithoutLinks++;
        if (sites.size > 1) episodesWithMultipleSites++;
        for (const site of sites) providerEpisodes.set(site, (providerEpisodes.get(site) || 0) + 1);
        for (const link of episode.links) providerLinks.set(link.source_site || "unknown", (providerLinks.get(link.source_site || "unknown") || 0) + 1);
      }
    }

    lastMediaItemId = items[items.length - 1].id;
    if (items.length < batchSize) break;
  }

  const duplicateGroups = [...duplicateBuckets.values()].filter((bucket) => bucket.length > 1);
  const providerRows: ProviderCount[] = [...providerLinks.keys()]
    .map((provider) => ({ provider, links: providerLinks.get(provider) || 0, episodes: providerEpisodes.get(provider) || 0 }))
    .sort((a, b) => b.links - a.links);
  const report = {
    generated_at: new Date().toISOString(),
    totals: { media_items: mediaItemsTotal, media_episodes: mediaEpisodes, episodes_without_links: episodesWithoutLinks, episodes_with_multiple_sites: episodesWithMultipleSites },
    by_kind: Object.fromEntries(kindTotals),
    providers: providerRows,
    duplicate_media_item_groups: duplicateGroups.length,
    duplicate_media_item_examples: duplicateGroups.slice(0, 30),
    note: "Los enlaces descubiertos no son prueba de reproducción; source_status debe avanzar mediante resolución JIT y validación del reproductor.",
  };

  const outputDir = path.join(process.cwd(), "docs", "workstreams");
  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(outputDir, `catalog_coverage_audit_${stamp}.json`), JSON.stringify(report, null, 2));
  const lines = [
    "# Auditoría de cobertura del catálogo",
    `Generado: ${report.generated_at}`,
    "",
    `MediaItems: ${mediaItemsTotal} · MediaEpisodes: ${mediaEpisodes} · Sin SourceLink: ${episodesWithoutLinks} · Con 2+ proveedores: ${episodesWithMultipleSites}`,
    "",
    "| Proveedor | SourceLinks | Episodios con proveedor |",
    "|---|---:|---:|",
    ...providerRows.map((row) => `| ${row.provider} | ${row.links} | ${row.episodes} |`),
    "",
    "## Por tipo",
    "",
    "| Tipo | Obras | Episodios | Episodios con enlace |",
    "|---|---:|---:|---:|",
    ...Object.entries(report.by_kind).map(([kind, value]) => `| ${kind} | ${value.items} | ${value.episodes} | ${value.linked} |`),
    "",
    `Grupos de MediaItem potencialmente duplicados (misma clave normalizada/tipo/año): ${duplicateGroups.length}.`,
    "",
    report.note,
    "",
  ];
  fs.writeFileSync(path.join(outputDir, `catalog_coverage_audit_${stamp}.md`), lines.join("\n"));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(`[catalog-coverage] fatal: ${String((error as Error)?.message || error)}`);
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
