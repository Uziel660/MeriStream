import {
  type ProbeOptions,
  type ProbeResult,
  type ProbeState,
  probeStream,
} from "./scrapers/hostHealth";
import { runtimeBudget } from "./runtimeBudget";

export interface StreamHealthSnapshot {
  generatedAt: number;
  /** true when at least one returned item is outside its fresh TTL. */
  stale: boolean;
  results: ProbeResult[];
}

export interface StreamHealthServiceOptions {
  cacheTtlMs?: number;
  staleTtlMs?: number;
  now?: () => number;
  probe?: (url: string, opts?: ProbeOptions) => Promise<ProbeResult>;
  allowRefresh?: () => boolean;
}

interface CacheEntry {
  result: ProbeResult;
  storedAt: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_STALE_TTL_MS = 10 * 60_000;

function unknownResult(url: string): ProbeResult {
  return { url, ok: false, state: "unknown" as ProbeState };
}

/**
 * Health snapshots never wait for a network round-trip. Fresh values are
 * returned as-is; stale values are returned immediately while one deduplicated
 * background refresh per URL is started.
 */
export class StreamHealthService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly refreshes = new Map<string, Promise<ProbeResult>>();
  private readonly cacheTtlMs: number;
  private readonly staleTtlMs: number;
  private readonly now: () => number;
  private readonly probe: (url: string, opts?: ProbeOptions) => Promise<ProbeResult>;
  private readonly allowRefresh: () => boolean;

  constructor(options: StreamHealthServiceOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.staleTtlMs = Math.max(this.cacheTtlMs, options.staleTtlMs ?? DEFAULT_STALE_TTL_MS);
    this.now = options.now ?? Date.now;
    this.probe = options.probe ?? probeStream;
    this.allowRefresh = options.allowRefresh ?? (() => true);
  }

  /** Gets a snapshot synchronously in practice (wrapped for route ergonomics). */
  async getSnapshot(urls: string[], opts: ProbeOptions = {}): Promise<StreamHealthSnapshot> {
    const now = this.now();
    const refreshUrls: string[] = [];
    let stale = false;
    const results = urls.map((url) => {
      const entry = this.cache.get(url);
      if (!entry) {
        refreshUrls.push(url);
        return unknownResult(url);
      }
      const age = Math.max(0, now - entry.storedAt);
      if (age <= this.cacheTtlMs) return { ...entry.result, fromCache: true, cacheStale: false };
      if (age <= this.staleTtlMs) {
        stale = true;
        refreshUrls.push(url);
        return { ...entry.result, fromCache: true, cacheStale: true };
      }
      refreshUrls.push(url);
      return unknownResult(url);
    });

    // Do not await this call: stale-while-revalidate is the important part of
    // this API. Promise rejection is consumed so a dead origin cannot become a
    // process-level unhandled rejection.
    if (refreshUrls.length > 0 && this.allowRefresh()) {
      void this.refresh(refreshUrls, opts).catch(() => undefined);
    }
    return { generatedAt: now, stale, results };
  }

  /** Performs and stores probes, deduplicating concurrent refreshes per URL. */
  async refresh(urls: string[], opts: ProbeOptions = {}): Promise<ProbeResult[]> {
    const uniqueUrls = [...new Set(urls)];
    const promises = uniqueUrls.map((url) => this.refreshOne(url, opts));
    return Promise.all(promises);
  }

  private refreshOne(url: string, opts: ProbeOptions): Promise<ProbeResult> {
    const existing = this.refreshes.get(url);
    if (existing) return existing;
    const promise = this.probe(url, opts)
      .catch((error): ProbeResult => ({
        url,
        ok: false,
        state: "degraded",
        reason: "network_error",
        error: error instanceof Error ? error.message : String(error),
      }))
      .then((result) => {
        this.cache.set(url, { result, storedAt: this.now() });
        return result;
      })
      .finally(() => this.refreshes.delete(url));
    this.refreshes.set(url, promise);
    return promise;
  }

  clear(urls?: string[]): void {
    if (!urls) {
      this.cache.clear();
      return;
    }
    for (const url of urls) this.cache.delete(url);
  }

  getCached(url: string): ProbeResult | undefined {
    return this.cache.get(url)?.result;
  }
}

export const streamHealthService = new StreamHealthService({
  allowRefresh: () => runtimeBudget.snapshot({ refreshMemory: false }).allowSpeculativeWork,
});

export function createStreamHealthService(options: StreamHealthServiceOptions = {}): StreamHealthService {
  return new StreamHealthService(options);
}

export function getStreamHealthSnapshot(urls: string[], opts: ProbeOptions = {}): Promise<StreamHealthSnapshot> {
  return streamHealthService.getSnapshot(urls, opts);
}
