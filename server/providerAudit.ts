import { analyzeUniversalUrl, extractStreamFromUrl, PRESET_SOURCES, scraperManager } from "./universalScraper";
import { upsertAutomatedCatalogReport, resolveAutomatedCatalogReports } from "./catalogReports";
import { dedupeCatalogItems } from "./catalogIntegrity";
import { isCatalogNavigationLocator } from "./sourceLinkAudit";
import { normalizeTitleKey, isPlausibleTitle } from "./utils/titleNormalizer";
import { auditDirectProviders, type DirectProviderAuditSummary } from "./directProviderAudit";
import { getProviderPolicy } from "./providers/providerPolicy";
import type { ContentKind, ExtractedCatalogItem, UniversalAnalysisResult } from "./types";

/** A bounded, read-only conformance check for one public provider catalog. */
export interface ProviderAuditTarget {
  provider: string;
  url: string;
  label?: string;
  mode?: "catalog" | "detail";
  mirror?: boolean;
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
  candidates_checked?: number;
  audit_kind?: "catalog" | "direct_api";
  lifecycle?: string;
  configured?: boolean;
  checked_kinds?: string[];
  failed_kinds?: string[];
  persistence_error?: string;
}

export interface ProviderAuditSummary {
  generated_at: string;
  duration_ms: number;
  inspected: number;
  healthy: number;
  failed: number;
  manual_review: number;
  entries: ProviderAuditEntry[];
  direct_api?: DirectProviderAuditSummary;
}

const CORE_TARGETS: ProviderAuditTarget[] = [
  ["animeflv", "https://animeflv.ar/anime/"],
  ["jkanime", "https://jkanime.net/buscar/one-piece/"],
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
  ["lamovie-movies", "https://lamovie.org/peliculas/"],
  ["lamovie-series", "https://lamovie.org/series/"],
  ["lamovie-anime", "https://lamovie.org/animes/"],
  ["gnula-movies", "https://gnula.life/archives/movies"],
  ["gnula-series", "https://gnula.life/archives/series"],
  ["animeav1", "https://animeav1.com/catalogo"],
  ["zokoanime", "https://zokoanime.video/stream/mal/32281/1/sub", "detail"],
  ["hianimes", "https://hianimes.se/filter?type=All&page=1"],
  ["veranimes", "https://wwv.veranimes.net/animes"],
  ["tubepelis", "https://tubepelis.com/"],
  ["archive-org", "https://archive.org/details/his_girl_friday", "detail"],
  ["tvmaze", "https://www.tvmaze.com/shows/169/breaking-bad", "detail"],
].map(([provider, url, mode]) => ({ provider, url, mode: mode as "catalog" | "detail" | undefined }));

const REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_CONCURRENCY = 3;
// A provider catalog can put premieres without uploaded episodes first. Keep
// the conformance check bounded, but sample enough cards to find a genuinely
// playable contract before reporting the provider as unavailable.
const MAX_CATALOG_CONTRACT_CANDIDATES = 12;

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

function targetHost(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./i, "").toLowerCase(); }
  catch { return null; }
}

/**
 * Some catalogs show a translated display title while their detail route keeps
 * the original-language slug (for example `Insustituible` → `/irreplaceable`).
 * The page is internally consistent when that route slug matches the detail
 * title, so this is a localization variant rather than a wrong-work link.
 */
export function isLocalizedTitleVariant(candidateTitle: string, detailTitle: string, url: string): boolean {
  const candidateKey = normalizeTitleKey(candidateTitle);
  const detailKey = normalizeTitleKey(detailTitle);
  if (!candidateKey || !detailKey || candidateKey === detailKey) return false;
  try {
    const pathParts = new URL(url).pathname.split("/").filter(Boolean);
    const rawSlug = pathParts[pathParts.length - 1]?.replace(/\.(?:html?|php)$/i, "") || "";
    const slugKey = normalizeTitleKey(rawSlug.replace(/[-_]+/g, " "));
    return Boolean(slugKey && (slugKey === detailKey || slugKey === candidateKey));
  } catch {
    return false;
  }
}

function policyForTarget(provider: string) {
  const exact = getProviderPolicy(provider);
  if (exact) return exact;
  const parts = provider.toLowerCase().split("-");
  for (let end = parts.length - 1; end > 0; end -= 1) {
    const candidate = getProviderPolicy(parts.slice(0, end).join("-"));
    if (candidate) return candidate;
  }
  return undefined;
}

/**
 * Expand a catalog target to policy-declared page mirrors. Streaming/CDN
 * hosts are intentionally excluded unless their label identifies the same
 * provider; this prevents vimeos/goodstream/sprintcdn from being mistaken for
 * catalog mirrors while still checking variants such as gnula.life and
 * animeflv.to. Each mirror keeps the original path so a failed host is
 * reported and can be replaced without changing the canonical locator.
 */
function expandCatalogMirrors(targets: ProviderAuditTarget[]): ProviderAuditTarget[] {
  const expanded = [...targets];
  for (const target of targets) {
    const policy = policyForTarget(target.provider);
    const sourceHost = targetHost(target.url);
    if (!policy?.hosts?.length || !sourceHost) continue;
    const sourceLabel = sourceHost.split(".")[0];
    const providerLabel = target.provider.toLowerCase().split("-")[0];
    const targetKind = /\/(?:series|tvshows)\b/i.test(target.url)
      ? "series"
      : /\/(?:animes|anime)\b/i.test(target.url)
        ? "anime"
        : "movie";
    if (policy.mirrorContentKinds?.length && !policy.mirrorContentKinds.includes(targetKind as any)) continue;
    for (const rawHost of policy.hosts) {
      const host = String(rawHost || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].toLowerCase();
      if (!host || host === sourceHost) continue;
      const label = host.split(".")[0];
      const isProviderMirror = label.includes(providerLabel) || label.includes(sourceLabel) || sourceLabel.includes(label);
      if (!isProviderMirror) continue;
      let url: string;
      try {
        const parsed = new URL(target.url);
        parsed.hostname = host;
        url = parsed.toString();
      } catch { continue; }
      if (targets.some((candidate) => pair(candidate.url) === pair(url)) || expanded.some((candidate) => pair(candidate.url) === pair(url))) continue;
      expanded.push({ ...target, provider: `${target.provider}-mirror-${label}`, url, mirror: true, label: `${target.label || target.provider} mirror ${host}` });
    }
  }
  return expanded;
}

/** Returns every maintained and legacy adapter target, deduplicated by URL. */
export function getProviderAuditTargets(): ProviderAuditTarget[] {
  const byUrl = new Map<string, ProviderAuditTarget>();
  for (const target of CORE_TARGETS) byUrl.set(pair(target.url), target);
  for (const preset of PRESET_SOURCES) {
    const target = targetFromPreset(preset);
    if (target && !byUrl.has(pair(target.url))) byUrl.set(pair(target.url), target);
  }
  return expandCatalogMirrors([...byUrl.values()]);
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
    const requestedMode = target.mode || "catalog";
    const catalog = await withTimeout(analyzeUniversalUrl(target.url, requestedMode, adapterId));
    const items = requestedMode === "detail"
      ? [{ title: catalog.title, url: target.url, kind: catalog.content_type } as ExtractedCatalogItem]
      : dedupeCatalogItems(catalog.catalog_items || []).filter((candidate) => isPlausibleTitle(candidate.title));
    if (items.length === 0) throw new Error("catalog_empty_or_unreadable");
    // A catalog can begin with a future title (no links yet) or a movie whose
    // provider has not uploaded the first server. Probe a bounded sample and
    // select the first genuinely playable contract instead of declaring the
    // entire provider dead from one unlucky card.
    const candidates = requestedMode === "detail" ? [items[0]] : items.slice(0, MAX_CATALOG_CONTRACT_CANDIDATES);
    let checkedCandidates = 0;
    let best: { item: ExtractedCatalogItem; detail: UniversalAnalysisResult; streamResult: { stream_url?: string; all_available_streams?: string[] } | null; anomalies: string[]; streams: string[]; score: number } | null = null;
    for (const candidate of candidates) {
      checkedCandidates += 1;
      const candidateAnomalies: string[] = [];
      if (requestedMode === "catalog" && isCatalogNavigationLocator(candidate.url)) candidateAnomalies.push("catalog_locator_returned_as_item");
      if (!/^https?:\/\//i.test(candidate.url)) candidateAnomalies.push("catalog_item_invalid_url");
      if (!isPlausibleTitle(candidate.title)) candidateAnomalies.push("catalog_item_invalid_title");
      let candidateDetail: UniversalAnalysisResult;
      try {
        candidateDetail = requestedMode === "detail" ? catalog : await withTimeout(analyzeUniversalUrl(candidate.url, "detail", adapterId));
      } catch (error: any) {
        candidateAnomalies.push(`detail_fetch_${String(error?.message || error).slice(0, 120)}`);
        continue;
      }
      if (!candidateDetail.title || !isPlausibleTitle(candidateDetail.title)) candidateAnomalies.push("detail_missing_title");
      if (candidateDetail.page_type === "catalog") candidateAnomalies.push("detail_resolved_to_catalog");
      if (normalizeTitleKey(candidateDetail.title) && normalizeTitleKey(candidate.title) &&
        !normalizeTitleKey(candidateDetail.title).includes(normalizeTitleKey(candidate.title)) &&
        !normalizeTitleKey(candidate.title).includes(normalizeTitleKey(candidateDetail.title))) {
        candidateAnomalies.push(
          isLocalizedTitleVariant(candidate.title, candidateDetail.title, candidate.url)
            ? "localized_title_variant"
            : "detail_title_mismatch",
        );
      }
      const kind = inferKind(target.provider, candidate);
      if ((kind === "series" || kind === "anime") && candidateDetail.episodes.length === 0) candidateAnomalies.push("detail_without_episodes");
      let candidateStream: { stream_url?: string; all_available_streams?: string[] } | null = null;
      const episodeUrl = candidateDetail.episodes[0]?.url || (kind === "movie" ? candidate.url : "");
      if (episodeUrl) {
        try { candidateStream = await withTimeout(extractStreamFromUrl(episodeUrl, adapterId)); }
        catch (error: any) { candidateAnomalies.push(`stream_extraction_${String(error?.message || error).slice(0, 120)}`); }
      }
      const candidateStreams = detailSources(candidateDetail, candidateStream);
      if (candidateStreams.length === 0) candidateAnomalies.push("no_playable_source");
      const score = (candidateStreams.length > 0 ? 100000 : 0) + candidateDetail.episodes.length * 100 - candidateAnomalies.length;
      if (!best || score > best.score) best = { item: candidate, detail: candidateDetail, streamResult: candidateStream, anomalies: candidateAnomalies, streams: candidateStreams, score };
      if (candidateStreams.length > 0 && candidateDetail.episodes.length > 0) break;
    }
    if (!best) throw new Error("detail_empty_or_unreadable");
    item = best.item;
    detail = best.detail;
    streamResult = best.streamResult;
    anomalies.push(...best.anomalies);
    const streams = best.streams;
    const requiresPlayableSource = target.provider !== "tvmaze";
    if (streams.length === 0) anomalies.push("no_playable_source");
    const manual = anomalies.some((value) => /locator|slug|invalid/i.test(value));
    // TVMaze is deliberately a metadata-only target. Its detail/episode
    // contract is useful for cross-checking identity, but it must not be
    // reported as a broken video provider when it exposes no streams.
    const hardFailure = (requiresPlayableSource && anomalies.includes("no_playable_source")) || anomalies.includes("detail_without_episodes") || manual;
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
      candidates_checked: checkedCandidates,
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
      candidates_checked: 0,
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
      candidates_checked: entry.candidates_checked,
      audit_kind: entry.audit_kind || "catalog",
      lifecycle: entry.lifecycle,
      configured: entry.configured,
      checked_kinds: entry.checked_kinds,
      failed_kinds: entry.failed_kinds,
      anomalies: entry.anomalies,
      checked_at: new Date().toISOString(),
    }),
  };
  if (entry.ok) {
    if (entry.anomalies.some((value) => /mismatch/i.test(value))) {
      await upsertAutomatedCatalogReport({
        ...base,
        reportType: "provider_metadata_mismatch",
      });
      return;
    }
    await Promise.all([
      resolveAutomatedCatalogReports({ reportType: "provider_catalog_failure", sourceProvider: entry.provider, sourceUrl: entry.url }),
      resolveAutomatedCatalogReports({ reportType: "provider_no_playable_source", sourceProvider: entry.provider, sourceUrl: entry.url }),
      resolveAutomatedCatalogReports({ reportType: "provider_metadata_mismatch", sourceProvider: entry.provider, sourceUrl: entry.url }),
      resolveAutomatedCatalogReports({ reportType: "provider_slug_changed", sourceProvider: entry.provider, sourceUrl: entry.url }),
      resolveAutomatedCatalogReports({ reportType: "provider_mirror_failed", sourceProvider: entry.provider, sourceUrl: entry.url }),
    ]);
    return;
  }
  const reportType = /FETCH_FAILED|timeout_|mirror|gnulahd\.nu/i.test(entry.anomalies.join(" "))
    ? "provider_mirror_failed"
    : entry.anomalies.some((value) => /mismatch/i.test(value))
    ? "provider_metadata_mismatch"
    : entry.anomalies.some((value) => /locator|slug|invalid/i.test(value))
    ? "provider_slug_changed"
    : entry.anomalies.includes("no_playable_source")
      ? "provider_no_playable_source"
      : "provider_catalog_failure";
  await upsertAutomatedCatalogReport({ ...base, reportType });
}

function directEntryToProviderEntry(entry: import("./directProviderAudit").DirectProviderAuditEntry): ProviderAuditEntry {
  return {
    provider: entry.provider,
    url: `direct-provider://${entry.provider}`,
    adapter_id: entry.registered ? entry.provider : null,
    ok: entry.ok,
    catalog_items: 0,
    detail_title: null,
    episodes: 0,
    streams: entry.playable_sources,
    checked_detail: false,
    anomalies: entry.anomalies,
    duration_ms: entry.duration_ms,
    candidates_checked: entry.checked_kinds.length,
    audit_kind: "direct_api",
    lifecycle: entry.lifecycle,
    configured: entry.configured,
    checked_kinds: entry.checked_kinds,
    failed_kinds: entry.failed_kinds,
  };
}

export async function auditProviders(options: {
  targets?: ProviderAuditTarget[];
  concurrency?: number;
  limit?: number;
  includeDirect?: boolean;
} = {}): Promise<ProviderAuditSummary> {
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
      try { await persistEntry(entry); } catch (error: any) {
        // A local read-only audit must remain useful when Prisma is not
        // connected. Keep the transport result authoritative and expose the
        // report-write problem separately instead of turning a healthy
        // provider into a false playback failure.
        entry.persistence_error = String(error?.message || error).slice(0, 160);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length || 1) }, () => worker()));
  let directApi: DirectProviderAuditSummary | undefined;
  if (options.includeDirect !== false) {
    directApi = await auditDirectProviders({ concurrency: Math.min(4, concurrency) });
    const directEntries = directApi.entries.map(directEntryToProviderEntry);
    await Promise.all(directEntries.map(async (entry) => {
      try { await persistEntry(entry); } catch (error: any) {
        entry.persistence_error = String(error?.message || error).slice(0, 160);
      }
    }));
    entries.push(...directEntries);
  }
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
    ...(directApi ? { direct_api: directApi } : {}),
  };
}

