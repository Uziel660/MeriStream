import "dotenv/config";
import { prisma } from "../server/db";

const ACTIVE_SITES = new Set([
  "cinecalidad",
  "gnula",
  "latanime",
  "zokoanime",
  "zokoanime.video",
]);
const LINK_TYPES = new Set(["page", "embed", "direct"]);

function isCatalogLocator(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (/\/(?:page|pagina)\/\d+\/?$/.test(path)) return true;
    if (/\/ver\/(?:peliculas|series|anime)\/?$/.test(path)) return true;
    if (/\/animes?\/?$/.test(path) && parsed.searchParams.has("p")) return true;
    return false;
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  const rawSince = String(process.env.MERISTREAM_IMPORT_AUDIT_SINCE || "").trim();
  const since = rawSince ? new Date(rawSince) : new Date(Date.now() - 30 * 60 * 1000);
  if (!Number.isFinite(since.getTime())) throw new Error(`Invalid MERISTREAM_IMPORT_AUDIT_SINCE: ${rawSince}`);

  const links = await prisma.sourceLink.findMany({
    where: { last_checked: { gte: since }, source_site: { in: [...ACTIVE_SITES] } },
    select: {
      source_site: true,
      url: true,
      link_type: true,
      canonical_locator: true,
      host: true,
      resolver_version: true,
      media_episode: { select: { season_number: true, episode_number: true } },
    },
  });

  const violations: Array<{ reason: string; source_site: string; url: string }> = [];
  for (const link of links) {
    const url = String(link.url || "").trim();
    const safeUrl = url.split("?")[0];
    if (!url) violations.push({ reason: "empty_url", source_site: link.source_site, url: safeUrl });
    if (!LINK_TYPES.has(link.link_type)) violations.push({ reason: "unsupported_link_type", source_site: link.source_site, url: safeUrl });
    if ((link.link_type === "page" || link.link_type === "embed") && !link.canonical_locator) {
      violations.push({ reason: "missing_canonical_locator", source_site: link.source_site, url: safeUrl });
    }
    if ((link.link_type === "page" || link.link_type === "embed") && isCatalogLocator(url)) {
      violations.push({ reason: "catalog_locator_saved_as_episode", source_site: link.source_site, url: safeUrl });
    }
    if (!link.host) violations.push({ reason: "missing_host", source_site: link.source_site, url: safeUrl });
    if (link.resolver_version !== "catalog-v2") {
      violations.push({ reason: "unexpected_resolver_version", source_site: link.source_site, url: safeUrl });
    }
    if (!Number.isFinite(Number(link.media_episode.season_number)) || Number(link.media_episode.season_number) < 1) {
      violations.push({ reason: "invalid_season", source_site: link.source_site, url: safeUrl });
    }
    if (!Number.isFinite(Number(link.media_episode.episode_number)) || Number(link.media_episode.episode_number) < 1) {
      violations.push({ reason: "invalid_episode", source_site: link.source_site, url: safeUrl });
    }
  }

  const duplicateEpisodes = await prisma.$queryRawUnsafe<Array<{ media_item_id: string; season_number: number; episode_number: number; count: number }>>(`
    SELECT media_item_id, season_number, episode_number, COUNT(*)::int AS count
    FROM "MediaEpisode"
    GROUP BY media_item_id, season_number, episode_number
    HAVING COUNT(*) > 1
    LIMIT 20
  `);

  const report = {
    since: since.toISOString(),
    linksChecked: links.length,
    sourceSites: [...new Set(links.map((link) => link.source_site))],
    violations: violations.slice(0, 50),
    violationCount: violations.length,
    duplicateEpisodes,
  };
  console.log(JSON.stringify(report, null, 2));
  if (violations.length > 0 || duplicateEpisodes.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
