import { analyzeUniversalUrl, extractStreamFromUrl, PRESET_SOURCES, scraperManager } from "./universalScraper";
import { upsertAutomatedCatalogReport, resolveAutomatedCatalogReports } from "./catalogReports";
import { dedupeCatalogItems, isInvalidCatalogSource } from "./catalogIntegrity";
import { isCatalogNavigationLocator } from "./sourceLinkAudit";
import { normalizeTitleKey, isPlausibleTitle } from "./utils/titleNormalizer";
import type { ContentKind, ExtractedCatalogItem, UniversalAnalysisResult } from "./types";

/** A bounded, read-only conformance check for one public provider catalog. */
export interface ProviderAuditTarget {
  provider: string;
  url: string;
  label?: string;
}

export interface ProviderAuditEntry {
  provider: string;
  url: string;
  adapter_id: string | null;
  ok: boolean;
  catalog_items: number;
  detail_title: string | null;
  episodes: number;
  streams: number;
  checked_detail: boolean;
  anomalies: string[];
  error?: string;
  duration_ms: number;
}

export interface ProviderAuditSummary {
  generated_at: string;
  duration_ms: number;
  inspected: number;
  healthy: number;
  failed: number;
  manual_review: number;
  entries: ProviderAuditEntry[];
}

const CORE_TARGETS: ProviderAuditTarget[] = [
  ["animeflv", "https://animeflv.or.at/anime/"],
  ["jkanime", "https://jkanime.net/directorio/"],
  ["tioanime", "https://tioanime.com/directorio"],
  ["latanime", "https://latanime.org/animes"],
  ["cinecalidad", "https://www.cinecalidad.am/"],
  ["tioplus", "https://tioplus.app/peliculas"],
  ["tioplus-series", "https://tioplus.app/series"],
  ["tioplus-doramas", "https://tioplus.app/doramas"],
  ["tioplus-anime", "https://tioplus.app/animes"],
  ["doramasflix", "https://doramasflix.io/doramas"],
  ["doramasflix-movies", "https://doramasflix.io/peliculas"],
  ["doramasia", "https://doramasia.com/doramas"],
  ["doramasia-movies", "https://doramasia.com/peliculas"],
  ["doramasyt", "https://www.doramasyt.com/doramas"],
  ["doramasyt-movies", "https://www.doramasyt.com/peliculas"],
  ["tudorama", "https://tudorama.com/genero/series/"],
  ["tudorama-movies", "https://tudorama.com/genero/peliculas/"],
  ["lamovie-movies", "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=movies&postsPerPage=24"],
  ["lamovie-series", "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=tvshows&postsPerPage=24"],
  ["lamovie-anime", "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=animes&postsPerPage=24"],
  ["gnula-movies", "https://gnula.life/archives/movies"],
  ["gnula-series", "https://gnula.life/archives/series"],
  ["animeav1", "https://animeav1.com/catalogo"],
  ["hianimes", "https://hianimes.se/filter?type=All&page=1"],
  ["veranimes", "https://wwv.veranimes.net/animes"],
  ["tubepelis", "https://tubepelis.com/"],
  ["archive-org", "https://archive.org/details/movies"],
  ["tvmaze", "https://www.tvmaze.com/shows"],
].map(([provider, url]) => ({ provider, url }));

const REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_CONCURRENCY = 3;

function withTimeout<T>(promise: Promise<T>, ms = REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout_${ms}ms`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function pair(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, "");
}

function inferKind(provider: string, item?: ExtractedCatalogItem | null): ContentKind {
  if (item?.kind) return item.kind;
  const id = provider.toLowerCase();
  if (id.includes("anime")) return "anime";
  if (id.includes("series") || id.includes("dorama") || id.includes("tv")) return "series";
  return "movie";
}

function detailSources(detail: UniversalAnalysisResult | null, streamResult?: { stream_url?: string; all_available_streams?: string[] } | null): string[] {
  const values: string[] = [];
  for (const value of detail?.detected_streams || []) if (typeof value === "string") values.push(value);
  for (const episode of detail?.episodes || []) {
    if (episode.url) values.push(episode.url);
    for (const source of episode.sources || []) if (source?.url) values.push(source.url);
  }
  if (streamResult?.stream_url) values.push(streamResult.stream_url);
  for (const value of streamResult?.all_available_streams || []) if (value) values.push(value);
  return [...new Set(values.filter((value) => /^https?:\/\//i.test(value)))];
}

function targetFromPreset(preset: typeof PRESET_SOURCES[number]): ProviderAuditTarget | null {
  if (/^open-|direct/i.test(preset.id) || /direct/i.test(preset.category)) return null;
  const id = preset.id.replace(/^(movies?|series|anime|variety)-/i, "").replace(/-movies?$/i, "").replace(/-series?$/i, "");
  return { provider: id || preset.id, url: preset.example_url, label: preset.name };
}

/** Returns every maintained and legacy adapter target, deduplicated by URL. */
export function getProviderAuditTargets(): ProviderAuditTarget[] {
  const byUrl = new Map<string, ProviderAuditTarget>();
  for (const target of CORE_TARGETS) byUrl.set(pair(target.url), target);
  for (const preset of PRESET_SOURCES) {
    const target = targetFromPreset(preset);
    if (target && !byUrl.has(pair(target.url))) byUrl.set(pair(target.url), target);
  }
  return [...byUrl.values()];
}

async function auditOne(target: ProviderAuditTarget): Promise<ProviderAuditEntry> {
  const started = Date.now();
  const anomalies: string[] = [];
  let adapterId: string | null = null;
  let item: ExtractedCatalogItem | undefined;
  let detail: UniversalAnalysisResult | null = null;
  let streamResult: { stream_url?: string; all_available_streams?: string[] } | null = null;
  try {
    adapterId = scraperManager.getAdapter(target.url).id;
    const catalog = await withTimeout(analyzeUniversalUrl(target.url, "catalog", adapterId));
    const items = dedupeCatalogItems(catalog.catalog_items || []).filter((candidate) => isPlausibleTitle(candidate.title));
    if (items.length === 0) {
      throw new Error("catalog_empty_or_unreadable");
    }
    item = items[0];
    if (isCatalogNavigationLocator(item.url) || isInvalidCatalogSource(item.url)) anomalies.push("catalog_locator_returned_as_item");
    if (!/^https?:\/\//i.test(item.url)) anomalies.push("catalog_item_invalid_url");
    if (!isPlausibleTitle(item.title)) anomalies.push("catalog_item_invalid_title");

    detail = await withTimeout(analyzeUniversalUrl(item.url, "detail", adapterId));
    if (!detail.title || !isPlausibleTitle(detail.title)) anomalies.push("detail_missing_title");
    if (detail.page_type === "catalog") anomalies.push("detail_resolved_to_catalog");
    if (normalizeTitleKey(detail.title) && normalizeTitleKey(item.title) &&
      !normalizeTitleKey(detail.title).includes(normalizeTitleKey(item.title)) &&
      !normalizeTitleKey(item.title).includes(normalizeTitleKey(detail.title))) {
      anomalies.push("detail_title_mismatch");
    }
    const kind = inferKind(target.provider, item);
    if ((kind === "series" || kind === "anime") && detail.episodes.length === 0) anomalies.push("detail_without_episodes");
    const episodeUrl = detail.episodes[0]?.url || (kind === "movie" ? item.url : "");
    if (episodeUrl) {
      try {
        streamResult = await withTimeout(extractStreamFromUrl(episodeUrl, adapterId));
      } catch (error: any) {
        anomalies.push(`stream_extraction_${String(error?.message || error).slice(0, 120)}`);
      }
    }
    const streams = detailSources(detail, streamResult);
    if (streams.length === 0) anomalies.push("no_playable_source");
    const manual = anomalies.some((value) => /locator|slug|mismatch|invalid/i.test(value));
    const hardFailure = anomalies.includes("no_playable_source") || anomalies.includes("detail_without_episodes") || manual;
    return {
      provider: target.provider,
      url: target.url,
      adapter_id: adapterId,
      ok: !hardFailure,
      catalog_items: items.length,
      detail_title: detail.title || null,
      episodes: detail.episodes.length,
      streams: streams.length,
      checked_detail: true,
      anomalies,
      duration_ms: Date.now() - started,
    };
  } catch (error: any) {
    const message = String(error?.message || error || "provider_audit_failed").slice(0, 240);
    return {
      provider: target.provider,
      url: target.url,
      adapter_id: adapterId,
      ok: false,
      catalog_items: 0,
      detail_title: null,
      episodes: 0,
      streams: 0,
      checked_detail: Boolean(detail),
      anomalies: [message],
      error: message,
      duration_ms: Date.now() - started,
    };
  }
}

async function persistEntry(entry: ProviderAuditEntry): Promise<void> {
  const base = {
    title: `Proveedor ${entry.provider}`,
    kind: entry.episodes > 0 ? "series" : "movie",
    sourceProvider: entry.provider,
    sourceUrl: entry.url,
    details: JSON.stringify({
      adapter_id: entry.adapter_id,
      catalog_items: entry.catalog_items,
      detail_title: entry.detail_title,
      episodes: entry.episodes,
      streams: entry.streams,
      anomalies: entry.anomalies,
      checked_at: new Date().toISOString(),
    }),
  };
  if (entry.ok) {
    await Promise.all([
      resolveAutomatedCatalogReports({ reportType: "provider_catalog_failure", sourceProvider: entry.provider, sourceUrl: entry.url }),
      resolveAutomatedCatalogReports({ reportType: "provider_no_playable_source", sourceProvider: entry.provider, sourceUrl: entry.url }),
      resolveAutomatedCatalogReports({ reportType: "provider_metadata_mismatch", sourceProvider: entry.provider, sourceUrl: entry.url }),
      resolveAutomatedCatalogReports({ reportType: "provider_slug_changed", sourceProvider: entry.provider, sourceUrl: entry.url }),
    ]);
    return;
  }
  const reportType = entry.anomalies.some((value) => /locator|slug|mismatch|invalid/i.test(value))
    ? "provider_slug_changed"
    : entry.anomalies.includes("no_playable_source")
      ? "provider_no_playable_source"
      : "provider_catalog_failure";
  await upsertAutomatedCatalogReport({ ...base, reportType });
}

export async function auditProviders(options: { targets?: ProviderAuditTarget[]; concurrency?: number; limit?: number } = {}): Promise<ProviderAuditSummary> {
  const started = Date.now();
  const targets = (options.targets || getProviderAuditTargets()).slice(0, Math.min(100, Math.max(1, Number(options.limit) || 100)));
  const concurrency = Math.min(8, Math.max(1, Math.round(Number(options.concurrency) || DEFAULT_CONCURRENCY)));
  const entries: ProviderAuditEntry[] = [];
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= targets.length) return;
      const entry = await auditOne(targets[index]);
      entries[index] = entry;
      try { await persistEntry(entry); } catch (error: any) { entry.anomalies.push(`report_persist_${String(error?.message || error).slice(0, 100)}`); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length || 1) }, () => worker()));
  const healthy = entries.filter((entry) => entry?.ok).length;
  const failed = entries.length - healthy;
  const manualReview = entries.filter((entry) => entry?.anomalies.some((value) => /locator|slug|mismatch|invalid/i.test(value))).length;
  return {
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    inspected: entries.length,
    healthy,
    failed,
    manual_review: manualReview,
    entries,
  };
}

