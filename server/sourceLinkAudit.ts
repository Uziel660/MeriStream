import { prisma } from "./db";
import { classifySourceKind } from "./resolutionMetadata";
import { getProviderPolicy } from "./providers/providerPolicy";

export type SourceAuditReason =
  | "catalog_navigation_locator"
  | "provider_page_host_mismatch"
  | "ephemeral_direct_requires_jit"
  | "invalid_url"
  | "http_4xx"
  | "http_5xx"
  | "network_error";

export interface SourceAuditOptions {
  /** Maximum number of stale links inspected in one verification pass. */
  limit?: number;
  staleAfterMs?: number;
  concurrency?: number;
  fetch?: typeof fetch;
}

export interface SourceAuditSummary {
  inspected: number;
  healthy: number;
  failed: number;
  skippedFresh: number;
  catalogLocators: number;
  hostMismatches: number;
  ephemeralDirect: number;
  byProvider: Record<string, { inspected: number; healthy: number; failed: number }>;
  anomalies: Array<{ id: string; source_site: string; url: string; reason: SourceAuditReason }>;
}

type AuditRow = {
  id: string;
  source_site: string;
  url: string;
  link_type: string;
  canonical_locator: string | null;
  source_status: string;
  last_checked: Date | null;
};

const DEFAULT_LIMIT = 1000;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 8000;

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function hostname(raw: string): string | null {
  try { return new URL(raw).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}

/**
 * Detects a catalogue/navigation page accidentally saved as an episode locator.
 * Detail pages are intentionally not matched: provider slugs vary widely.
 */
export function isCatalogNavigationLocator(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    if (/\/page\/\d+$/.test(path)) return true;
    if (/\/(?:doramas|peliculas|pel[íi]culas|series|animes|anime|catalogo|directorio|variedades)$/.test(path)) return true;
    if (/\/archives\/(?:movies|series|animes?)$/.test(path)) return true;
    if (/\/genero\/(?:peliculas|series|anime|doramas)$/.test(path)) return true;
    return false;
  } catch { return true; }
}

function providerAllowsPageHost(sourceSite: string, url: string): boolean {
  const policy = getProviderPolicy(sourceSite);
  if (!policy?.hosts?.length) return true;
  const host = hostname(url);
  if (!host) return false;
  return policy.hosts.some((allowed) => {
    const clean = String(allowed).toLowerCase().replace(/^www\./, "");
    return host === clean || host.endsWith(`.${clean}`);
  });
}

function reasonForStatus(status: number): SourceAuditReason {
  return status >= 500 ? "http_5xx" : "http_4xx";
}

async function fetchPage(url: string, fetchImpl: typeof fetch): Promise<{ ok: boolean; reason?: SourceAuditReason }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8", "user-agent": "MeriStream-source-audit/1.0" },
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status >= 200 && response.status < 400
      ? { ok: true }
      : { ok: false, reason: reasonForStatus(response.status) };
  } catch {
    return { ok: false, reason: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

async function auditOne(row: AuditRow, fetchImpl: typeof fetch): Promise<{ ok: boolean; reason?: SourceAuditReason }> {
  if (!row.source_site) return { ok: false, reason: "invalid_url" };
  let parsed: URL;
  try { parsed = new URL(row.url); } catch { return { ok: false, reason: "invalid_url" }; }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, reason: "invalid_url" };

  const kind = classifySourceKind(row.url);
  if (kind === "ephemeral_direct") return { ok: false, reason: "ephemeral_direct_requires_jit" };
  if (row.link_type === "page" && isCatalogNavigationLocator(row.canonical_locator || row.url)) {
    return { ok: false, reason: "catalog_navigation_locator" };
  }
  // External hosts are expected for embeds (OK, Voe, Vidara, etc.). A page
  // locator, however, must remain on a verified host for its provider.
  if (row.link_type === "page" && !providerAllowsPageHost(row.source_site, row.canonical_locator || row.url)) {
    return { ok: false, reason: "provider_page_host_mismatch" };
  }
  if (kind === "stable_direct") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(row.url, { method: "GET", redirect: "follow", signal: controller.signal, headers: { range: "bytes=0-1", "user-agent": "MeriStream-source-audit/1.0" } });
      await response.body?.cancel().catch(() => undefined);
      return response.status >= 200 && response.status < 400 ? { ok: true } : { ok: false, reason: reasonForStatus(response.status) };
    } catch { return { ok: false, reason: "network_error" }; }
    finally { clearTimeout(timer); }
  }
  return fetchPage(row.canonical_locator || row.url, fetchImpl);
}

function addProvider(summary: SourceAuditSummary, sourceSite: string): { inspected: number; healthy: number; failed: number } {
  return summary.byProvider[sourceSite] || (summary.byProvider[sourceSite] = { inspected: 0, healthy: 0, failed: 0 });
}

/** Audits stale SourceLinks and persists health without deleting any catalog data. */
export async function auditSourceLinks(options: SourceAuditOptions = {}): Promise<SourceAuditSummary> {
  const limit = clamp(options.limit, DEFAULT_LIMIT, 1, 10_000);
  const staleAfterMs = clamp(options.staleAfterMs, DEFAULT_STALE_AFTER_MS, 60_000, 30 * 24 * 60 * 60 * 1000);
  const concurrency = clamp(options.concurrency, DEFAULT_CONCURRENCY, 1, 32);
  const fetchImpl = options.fetch || globalThis.fetch;
  const cutoff = new Date(Date.now() - staleAfterMs);
  const rows = await prisma.sourceLink.findMany({
    where: { OR: [{ last_checked: null }, { last_checked: { lt: cutoff } }] },
    orderBy: { last_checked: "asc" },
    take: limit,
    select: { id: true, source_site: true, url: true, link_type: true, canonical_locator: true, source_status: true, last_checked: true },
  }) as AuditRow[];

  const summary: SourceAuditSummary = { inspected: 0, healthy: 0, failed: 0, skippedFresh: 0, catalogLocators: 0, hostMismatches: 0, ephemeralDirect: 0, byProvider: {}, anomalies: [] };
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= rows.length) return;
      const row = rows[index];
      const provider = addProvider(summary, row.source_site);
      provider.inspected++;
      summary.inspected++;
      const result = await auditOne(row, fetchImpl);
      const checkedAt = new Date();
      if (result.ok) {
        summary.healthy++;
        provider.healthy++;
        await prisma.sourceLink.update({ where: { id: row.id }, data: { last_checked: checkedAt, last_success: checkedAt, failure_reason: null, source_status: row.source_status === "failed" ? "discovered" : row.source_status, retry_after: null } });
      } else {
        summary.failed++;
        provider.failed++;
        const reason = result.reason || "network_error";
        if (reason === "catalog_navigation_locator") summary.catalogLocators++;
        if (reason === "provider_page_host_mismatch") summary.hostMismatches++;
        if (reason === "ephemeral_direct_requires_jit") summary.ephemeralDirect++;
        if (summary.anomalies.length < 200) summary.anomalies.push({ id: row.id, source_site: row.source_site, url: row.url, reason });
        await prisma.sourceLink.update({ where: { id: row.id }, data: { last_checked: checkedAt, last_failure: checkedAt, failure_reason: reason, source_status: "failed", retry_after: new Date(Date.now() + 6 * 60 * 60 * 1000) } });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, rows.length)) }, () => worker()));
  return summary;
}
