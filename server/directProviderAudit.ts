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

const PROBE_TIMEOUT_MS = 16_000;
const MEDIA_TIMEOUT_MS = 6_000;

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
    case "anime-sdk": return Boolean(String(process.env.ANIME_SDK_URL || "").trim());
    case "streamprovider": return Boolean(String(process.env.STREAM_PROVIDER_URL || "").trim());
    case "stremio-direct": return Boolean(String(process.env.STREMIO_DIRECT_ADDONS || "").trim());
    default: return true;
  }
}

function candidatesWithPlayableMedia(values: PlayableSource[]): PlayableSource[] {
  return values.filter((source) => /^https?:\/\//i.test(source.url) && ["hls", "dash", "mp4"].includes(source.streamType));
}

async function probeCandidate(source: PlayableSource): Promise<boolean> {
  try {
    const result = await probeStream(source.url, {
      timeoutMs: MEDIA_TIMEOUT_MS,
      playerReferer: source.requiredHeaders?.Referer || source.canonicalLocator || undefined,
      requiredHeaders: source.requiredHeaders,
    });
    return result.ok;
  } catch {
    return false;
  }
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
      const sources = candidatesWithPlayableMedia(await withTimeout(provider.resolve(request), PROBE_TIMEOUT_MS));
      if (sources.length === 0) {
        failedKinds.push(kind);
        anomalies.push(`${kind}_no_playable_source`);
        continue;
      }
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

