import { getAllDirectStreamProviders, isDirectStreamProviderDisabled } from "./providers/api";
import type { DirectMediaKind, DirectStreamProvider, PlayableSource, ProviderRequest } from "./providers/api/types";
import { getProviderPolicy, PROVIDER_POLICIES } from "./providers/providerPolicy";
import { probeStream } from "./scrapers/hostHealth";

/**
 * Representative requests used only by the recurrent health check. They are
 * deliberately stable public TMDB/MAL identities and are never imported into
 * the catalog. Every API provider is tested for each media kind it advertises.
 */
const PROBE_REQUESTS: Record<DirectMediaKind, ProviderRequest> = {
  movie: {
    tmdbId: 550,
    kind: "movie",
    title: "Fight Club",
    year: 1999,
  },
  series: {
    // Attack on Titan is present on the current multi-language VidSrc path,
    // unlike several newer titles that are valid TMDB records but have no
    // upstream episode published yet.
    tmdbId: 1429,
    kind: "series",
    season: 1,
    episode: 1,
    title: "Attack on Titan",
    year: 2013,
  },
  anime: {
    // The same stable title is also a useful TV-shaped anime probe for direct
    // APIs that do not carry MAL/AniList identity in their locator.
    tmdbId: 1429,
    kind: "anime",
    season: 1,
    episode: 1,
    title: "Attack on Titan",
    year: 2013,
    malId: 16498,
  },
};

// VidSrc's anime compatibility path may need to try several mirrors and then
// repeat the TV-shaped request. A 16s cutoff produced false negatives during
// token rotation, so keep the health probe bounded but configurable at 30s.
const PROBE_TIMEOUT_MS = Math.max(16_000, Number(process.env.DIRECT_PROVIDER_AUDIT_TIMEOUT_MS || 30_000));
const MEDIA_TIMEOUT_MS = 6_000;
const RESOLVE_ATTEMPTS = Math.min(3, Math.max(2, Math.round(Number(process.env.DIRECT_PROVIDER_AUDIT_ATTEMPTS || 3))));

export interface DirectProviderAuditEntry {
  provider: string;
  lifecycle: string;
  registered: boolean;
  disabled: boolean;
  configured: boolean;
  ok: boolean;
  checked_kinds: DirectMediaKind[];
  failed_kinds: DirectMediaKind[];
  playable_sources: number;
  anomalies: string[];
  sample_urls: string[];
  duration_ms: number;
}

export interface DirectProviderAuditSummary {
  generated_at: string;
  duration_ms: number;
  inspected: number;
  healthy: number;
  failed: number;
  entries: DirectProviderAuditEntry[];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout_${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function configuredFor(provider: DirectStreamProvider): boolean {
  switch (provider.id) {
    // These public endpoints are retired/unreliable. Keep the clients
    // available for an explicitly configured self-host or mirror, but do not
    // call the dead defaults on every verification pass and report them as
    // healthy merely because a URL exists in the constructor fallback.
    case "flixquest":
      return Boolean(String(process.env.FLIXQUEST_API_URLS || process.env.FLIXQUEST_API_URL || "").trim());
    case "nuvio":
      return Boolean(String(process.env.NUVIO_STREAMS_URLS || process.env.NUVIO_STREAMS_URL || "").trim());
    // The anime-sdk client has a self-hosted in-process fallback; ANIME_SDK_URL
    // remains an optional override for operators that run its HTTP service.
    case "anime-sdk": return String(process.env.MERISTREAM_DISABLE_BUILTIN_ANIME_SDK || "").trim().toLowerCase() !== "true";
    case "streamprovider": return Boolean(String(process.env.STREAM_PROVIDER_URL || "").trim());
    case "stremio-direct": return Boolean(String(process.env.STREMIO_DIRECT_ADDONS || "").trim());
    default: return true;
  }
}

function candidatesWithPlayableMedia(values: PlayableSource[]): PlayableSource[] {
  return values.filter((source) => /^https?:\/\//i.test(source.url) && ["hls", "dash", "mp4"].includes(source.streamType));
}

function compatibleAnimeProbe(providerId: string, kind: DirectMediaKind): boolean {
  // VidSrc explicitly maps its anime path to the TMDB TV route when an anime
  // mirror rejects the `anime` label. Probe that same compatibility path so a
  // transient anime-only mirror failure does not mark the whole provider dead.
  return kind === "anime" && (providerId === "vidsrc" || providerId === "vidsrcto");
}

async function probeCandidate(source: PlayableSource): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await probeStream(source.url, {
        timeoutMs: MEDIA_TIMEOUT_MS,
        playerReferer: source.requiredHeaders?.Referer || source.canonicalLocator || undefined,
        requiredHeaders: source.requiredHeaders,
      });
      if (result.ok) return true;
    } catch {
      // A signed manifest/CDN edge can rotate between two requests. Retry the
      // same JIT locator once before marking the provider unhealthy.
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function auditRuntimeProvider(provider: DirectStreamProvider): Promise<DirectProviderAuditEntry> {
  const started = Date.now();
  const policy = getProviderPolicy(provider.id);
  const lifecycle = policy?.lifecycle || "unregistered";
  const disabled = isDirectStreamProviderDisabled(provider.id);
  const configured = configuredFor(provider);
  const checkedKinds = [...provider.kinds];
  const failedKinds: DirectMediaKind[] = [];
  const anomalies: string[] = [];
  const sampleUrls: string[] = [];
  let playableSources = 0;

  if (disabled) anomalies.push("disabled_by_config");
  if (!configured) anomalies.push("not_configured");

  // Disabled or intentionally unconfigured providers are still reported so
  // the administrator sees the exact reason, but the check does not make
  // network requests that cannot succeed by construction.
  if (disabled || !configured) {
    return {
      provider: provider.id,
      lifecycle,
      registered: true,
      disabled,
      configured,
      ok: false,
      checked_kinds: checkedKinds,
      failed_kinds: checkedKinds,
      playable_sources: 0,
      anomalies,
      sample_urls: sampleUrls,
      duration_ms: Date.now() - started,
    };
  }

  for (const kind of checkedKinds) {
    const request = PROBE_REQUESTS[kind];
    try {
      let sources: PlayableSource[] = [];
      let usedCompatibilityProbe = false;
      const probeRequests = compatibleAnimeProbe(provider.id, kind)
        ? [request, { ...request, kind: "series" as const }]
        : [request];
      // Public mirrors can rotate an upstream token between the embed request
      // and its manifest. Give a transient empty response one bounded retry so
      // the daily health report does not disable a provider that is actually
      // healthy (anime endpoints are especially prone to this).
      for (let requestIndex = 0; requestIndex < probeRequests.length && sources.length === 0; requestIndex++) {
        const probeRequest = probeRequests[requestIndex];
        for (let attempt = 0; attempt < RESOLVE_ATTEMPTS && sources.length === 0; attempt++) {
          try {
            const resolved = candidatesWithPlayableMedia(await withTimeout(provider.resolve(probeRequest), PROBE_TIMEOUT_MS));
            sources = resolved;
          } catch {
            // A compatibility request may still succeed on the next route;
            // keep the last bounded attempt's failure out of the final report
            // when a playable source is found there.
          }
          if (sources.length === 0 && attempt < RESOLVE_ATTEMPTS - 1) {
            await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
          }
        }
        usedCompatibilityProbe = requestIndex > 0 && sources.length > 0;
      }
      if (sources.length === 0) {
        failedKinds.push(kind);
        anomalies.push(`${kind}_no_playable_source`);
        continue;
      }
      if (usedCompatibilityProbe) anomalies.push(`${kind}_via_series_compatibility`);
      let kindHealthy = false;
      for (const source of sources.slice(0, 3)) {
        sampleUrls.push(source.canonicalLocator || source.url);
        if (await probeCandidate(source)) {
          playableSources += 1;
          kindHealthy = true;
          break;
        }
      }
      if (!kindHealthy) {
        failedKinds.push(kind);
        anomalies.push(`${kind}_media_probe_failed`);
      }
    } catch (error: any) {
      failedKinds.push(kind);
      anomalies.push(`${kind}_${String(error?.message || error).slice(0, 120)}`);
    }
  }

  return {
    provider: provider.id,
    lifecycle,
    registered: true,
    disabled,
    configured,
    ok: failedKinds.length === 0 && checkedKinds.length > 0,
    checked_kinds: checkedKinds,
    failed_kinds: failedKinds,
    playable_sources: playableSources,
    anomalies: [...new Set(anomalies)],
    sample_urls: [...new Set(sampleUrls)].slice(0, 6),
    duration_ms: Date.now() - started,
  };
}

function missingRuntimeEntries(runtimeIds: Set<string>): DirectProviderAuditEntry[] {
  return Object.values(PROVIDER_POLICIES)
    .filter((policy) => policy.discovery === "direct_api")
    .filter((policy) => !runtimeIds.has(policy.id))
    // These are handled by the catalog/source audit, not the direct API pool.
    .filter((policy) => policy.id !== "direct" && policy.id !== "doramasia")
    .map((policy) => ({
      provider: policy.id,
      lifecycle: policy.lifecycle,
      registered: false,
      disabled: false,
      configured: false,
      ok: false,
      checked_kinds: [],
      failed_kinds: [],
      playable_sources: 0,
      anomalies: ["no_runtime_client"],
      sample_urls: [],
      duration_ms: 0,
    }));
}

/**
 * Audit every registered direct API client, including legacy clients that are
 * filtered out of normal playback. Missing runtime implementations are
 * surfaced as explicit failures instead of disappearing from the report.
 */
export async function auditDirectProviders(options: {
  concurrency?: number;
  providers?: readonly DirectStreamProvider[];
} = {}): Promise<DirectProviderAuditSummary> {
  const started = Date.now();
  const providers = [...(options.providers || getAllDirectStreamProviders())];
  const concurrency = Math.min(4, Math.max(1, Math.round(Number(options.concurrency) || 2)));
  const entries: DirectProviderAuditEntry[] = [];
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= providers.length) return;
      entries[index] = await auditRuntimeProvider(providers[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, providers.length || 1) }, () => worker()));
  const runtimeIds = new Set(providers.map((provider) => provider.id));
  entries.push(...missingRuntimeEntries(runtimeIds));
  return {
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    inspected: entries.length,
    healthy: entries.filter((entry) => entry.ok).length,
    failed: entries.filter((entry) => !entry.ok).length,
    entries,
  };
}

