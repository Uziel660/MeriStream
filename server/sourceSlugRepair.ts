import { prisma } from "./db";
import { analyzeUniversalUrl, scraperManager } from "./universalScraper";
import { upsertAutomatedCatalogReport } from "./catalogReports";
import { isCatalogNavigationLocator } from "./sourceLinkAudit";
import { classifySourceKind } from "./resolutionMetadata";
import { getProviderPolicy } from "./providers/providerPolicy";
import { normalizeTitleKey } from "./utils/titleNormalizer";

export interface SlugRepairSummary {
  inspected: number;
  repaired: number;
  manual_review: number;
  skipped: number;
  errors: number;
  repairs: Array<{ source_site: string; title: string; episode: number; old_url: string; new_url: string }>;
}

const SEARCH_TIMEOUT_MS = 12_000;
const MAX_CANDIDATES = 8;

function withTimeout<T>(promise: Promise<T>, ms = SEARCH_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout_${ms}ms`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function host(raw: string): string | null {
  try { return new URL(raw).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}

function providerAcceptsLocator(sourceSite: string, locator: string): boolean {
  const policy = getProviderPolicy(sourceSite);
  if (!policy?.hosts?.length) return true;
  const value = host(locator);
  return Boolean(value && policy.hosts.some((allowed) => {
    const clean = String(allowed).toLowerCase().replace(/^www\./, "");
    return value === clean || value.endsWith(`.${clean}`);
  }));
}

export function exactRepairTitleMatch(candidate: string, expected: string): boolean {
  const left = normalizeTitleKey(candidate);
  const right = normalizeTitleKey(expected);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

function cleanCandidateUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((candidate): candidate is string => typeof candidate === "string" && /^https?:\/\//i.test(candidate)))].slice(0, MAX_CANDIDATES);
}

function episodeLocator(detail: any, episodeNumber: number, kind: string, fallback: string): string | null {
  const episodes = Array.isArray(detail?.episodes) ? detail.episodes : [];
  const exact = episodes.find((episode: any) => Math.abs(Number(episode?.number) - episodeNumber) < 0.01);
  const candidate = exact?.url || (kind === "movie" ? fallback : "");
  if (!candidate || isCatalogNavigationLocator(candidate)) return null;
  const sourceKind = classifySourceKind(candidate);
  return sourceKind === "page" || sourceKind === "embed" || sourceKind === "stable_direct" ? candidate : null;
}

type FailedSourceRow = {
  id: string;
  source_site: string;
  url: string;
  link_type: string;
  media_episode: {
    id: string;
    season_number: number;
    episode_number: number;
    media_item: { id: string; title: string; kind: string; year: number | null; tmdb_id: number | null };
  };
};

async function repairOne(row: FailedSourceRow): Promise<{ locator?: string; reason?: string }> {
  const media = row.media_episode.media_item;
  const adapterId = scraperManager.getAdapter(`https://${row.source_site}`).id;
  if (!adapterId || adapterId === "generic") return { reason: "adapter_unavailable" };
  const query = `${media.title} ${media.year || ""}`.trim();
  const analysis = await withTimeout(analyzeUniversalUrl(query, "auto", adapterId));
  const items = cleanCandidateUrls((analysis as any)?.catalog_items?.map((item: any) => item?.url));
  const matchingItems = ((analysis as any)?.catalog_items || []).filter((item: any) =>
    item?.url && exactRepairTitleMatch(String(item.title || ""), media.title) && providerAcceptsLocator(row.source_site, item.url),
  ).slice(0, MAX_CANDIDATES);
  const candidates = matchingItems.length > 0 ? matchingItems : items.map((url) => ({ url, title: media.title }));
  const locators: string[] = [];
  for (const item of candidates) {
    if (!providerAcceptsLocator(row.source_site, item.url) || isCatalogNavigationLocator(item.url)) continue;
    try {
      const detail = await withTimeout(analyzeUniversalUrl(item.url, "detail", adapterId));
      if (detail.title && !exactRepairTitleMatch(detail.title, media.title)) continue;
      const locator = episodeLocator(detail, row.media_episode.episode_number, media.kind, item.url);
      if (locator) locators.push(locator);
    } catch {}
  }
  const unique = [...new Set(locators)];
  if (unique.length !== 1) return { reason: unique.length === 0 ? "slug_not_found" : "ambiguous_slug" };
  return { locator: unique[0] };
}

/**
 * Repairs only failed provider page locators. The old row is retained as
 * evidence; a new canonical row is added only for one exact, same-provider
 * match, so a bad slug can never silently redirect to another title.
 */
export async function repairFailedSourceSlugs(options: { limit?: number; concurrency?: number } = {}): Promise<SlugRepairSummary> {
  const limit = Math.min(500, Math.max(1, Math.round(Number(options.limit) || 100)));
  const concurrency = Math.min(6, Math.max(1, Math.round(Number(options.concurrency) || 2)));
  const rows = await prisma.sourceLink.findMany({
    where: { source_status: "failed" },
    orderBy: { last_checked: "asc" },
    take: limit,
    select: {
      id: true,
      source_site: true,
      url: true,
      link_type: true,
      media_episode: {
        select: {
          id: true,
          season_number: true,
          episode_number: true,
          media_item: { select: { id: true, title: true, kind: true, year: true, tmdb_id: true } },
        },
      },
    },
  }) as FailedSourceRow[];
  const summary: SlugRepairSummary = { inspected: rows.length, repaired: 0, manual_review: 0, skipped: 0, errors: 0, repairs: [] };
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= rows.length) return;
      const row = rows[index];
      const media = row.media_episode.media_item;
      try {
        const result = await repairOne(row);
        if (!result.locator) {
          if (result.reason === "adapter_unavailable") summary.skipped++;
          else {
            summary.manual_review++;
            await upsertAutomatedCatalogReport({
              title: media.title,
              tmdbId: media.tmdb_id,
              kind: media.kind,
              episodeId: row.media_episode.id,
              episodeNumber: row.media_episode.episode_number,
              reportType: "provider_slug_changed",
              sourceProvider: row.source_site,
              sourceUrl: row.url,
              details: `No se pudo reparar automáticamente el slug (${result.reason || "unknown"}). Revisión manual requerida.`,
            });
          }
          continue;
        }
        const locator = result.locator;
        const now = new Date();
        const sourceSite = row.source_site;
        await prisma.sourceLink.upsert({
          where: { media_episode_id_source_site_url: { media_episode_id: row.media_episode.id, source_site: sourceSite, url: locator } },
          create: {
            media_episode_id: row.media_episode.id,
            source_site: sourceSite,
            url: locator,
            canonical_locator: locator,
            link_type: classifySourceKind(locator) === "embed" ? "embed" : classifySourceKind(locator) === "stable_direct" ? "direct" : "page",
            host: host(locator),
            is_verified: false,
            source_status: "discovered",
            extraction_method: "provider_slug_repair",
            resolver_version: "slug-repair-v1",
            last_checked: now,
          },
          update: {
            canonical_locator: locator,
            source_status: "discovered",
            failure_reason: null,
            extraction_method: "provider_slug_repair",
            resolver_version: "slug-repair-v1",
            last_checked: now,
            last_failure: null,
          },
        });
        await prisma.sourceLink.update({ where: { id: row.id }, data: { failure_reason: "slug_replaced", last_checked: now } });
        summary.repaired++;
        summary.repairs.push({ source_site: sourceSite, title: media.title, episode: row.media_episode.episode_number, old_url: row.url, new_url: locator });
      } catch (error: any) {
        summary.errors++;
        await upsertAutomatedCatalogReport({
          title: media.title,
          tmdbId: media.tmdb_id,
          kind: media.kind,
          episodeId: row.media_episode.id,
          episodeNumber: row.media_episode.episode_number,
          reportType: "provider_mirror_failed",
          sourceProvider: row.source_site,
          sourceUrl: row.url,
          details: `Error reparando el enlace: ${String(error?.message || error).slice(0, 500)}`,
        }).catch(() => undefined);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length || 1) }, () => worker()));
  return summary;
}

