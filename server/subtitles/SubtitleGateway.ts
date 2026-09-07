import { ExternalIdResolver, normalizePreferredLanguages } from "./ExternalIdResolver";
import { SubtitleHealth } from "./SubtitleHealth";
import { dedupeSubtitleCandidates } from "./SubtitleNormalizer";
import { rankSubtitleCandidates } from "./SubtitleRanker";
import { SubtitleCache } from "./SubtitleCache";
import { SubtitleProxy } from "./SubtitleProxy";
import type { SubtitleCandidate, SubtitleGatewayResult, SubtitleProvider, SubtitleSearchRequest, SubtitleTrack } from "./types";
import { OpenSubtitlesProvider } from "./providers/OpenSubtitlesProvider";
import { TvSubtitlesProvider } from "./providers/TvSubtitlesProvider";
import { YifySubtitlesProvider } from "./providers/YifySubtitlesProvider";

const SEARCH_TTL_MS = Math.max(60 * 60_000, Number(process.env.SUBTITLE_SEARCH_CACHE_TTL_MS || 4 * 60 * 60_000));
const PROVIDER_TIMEOUT_MS = Math.max(1_000, Number(process.env.SUBTITLE_PROVIDER_TIMEOUT_MS || 8_000));

export class SubtitleGateway {
  readonly proxy: SubtitleProxy;
  private readonly searchCache = new SubtitleCache<SubtitleCandidate[]>(512);
  private readonly health = new SubtitleHealth();
  private readonly idResolver: ExternalIdResolver;

  constructor(
    private readonly providers: readonly SubtitleProvider[],
    options: { proxy?: SubtitleProxy; idResolver?: ExternalIdResolver; providerTimeoutMs?: number } = {},
  ) {
    this.proxy = options.proxy || new SubtitleProxy();
    this.idResolver = options.idResolver || new ExternalIdResolver();
    this.providerTimeoutMs = Math.max(1, options.providerTimeoutMs || PROVIDER_TIMEOUT_MS);
  }

  private readonly providerTimeoutMs: number;

  async search(request: SubtitleSearchRequest): Promise<SubtitleGatewayResult> {
    const started = Date.now();
    const languages = normalizePreferredLanguages(request.preferredLanguages);
    const cacheKey = this.cacheKey(request, languages);
    const cached = this.searchCache.get(cacheKey);
    const queried = cached ? { candidates: cached, failed: [] } : await this.queryProviders({ ...request, preferredLanguages: languages });
    const candidates = queried.candidates;
    if (!cached) this.searchCache.set(cacheKey, candidates, SEARCH_TTL_MS);

    const ranked = rankSubtitleCandidates(dedupeSubtitleCandidates(candidates), languages);
    const tracks: SubtitleTrack[] = [];
    for (const candidate of ranked) {
      const url = this.proxy.register(candidate);
      if (!url) continue;
      tracks.push({
        id: candidate.id,
        label: candidate.label,
        language: candidate.language,
        url,
        is_default: false,
        provider: candidate.provider,
      });
    }
    const defaultTrack = tracks.find((track) => track.language === languages[0]) || tracks[0];
    if (defaultTrack) defaultTrack.is_default = true;

    return {
      subtitles: tracks,
      tracks,
      providers: {
        queried: this.providers.filter((provider) => provider.kinds.includes(request.kind)).map((provider) => provider.id),
        failed: queried.failed,
      },
      elapsedMs: Date.now() - started,
      cached: Boolean(cached),
    };
  }

  healthSnapshot(): Record<string, unknown> {
    return this.health.snapshot();
  }

  clearCache(): void {
    this.searchCache.clear();
    this.idResolver.clear();
  }

  private async queryProviders(request: SubtitleSearchRequest): Promise<{ candidates: SubtitleCandidate[]; failed: Array<{ provider: string; reason: string }> }> {
    const imdbId = await this.idResolver.resolve(request);
    const resolved = { ...request, imdbId };
    const eligible = this.providers.filter((provider) => provider.kinds.includes(request.kind) && this.health.isAvailable(provider.id));
    const skipped = this.providers
      .filter((provider) => provider.kinds.includes(request.kind) && !this.health.isAvailable(provider.id))
      .map((provider) => ({ provider: provider.id, reason: "cooldown" }));
    const results = await Promise.allSettled(eligible.map(async (provider) => {
      const started = Date.now();
      try {
        const result = await withTimeout(provider.search(resolved), this.providerTimeoutMs);
        this.health.success(provider.id, Date.now() - started);
        return result;
      } catch (error) {
        this.health.failure(provider.id);
        throw error instanceof Error ? error : new Error(String(error));
      }
    }));
    const candidates: SubtitleCandidate[] = [];
    const failed = [...skipped];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") candidates.push(...result.value);
      else failed.push({ provider: eligible[index].id, reason: result.reason instanceof Error ? result.reason.message : "provider_failed" });
    });
    return { candidates, failed };
  }

  private cacheKey(request: SubtitleSearchRequest, languages: string[]): string {
    return [request.kind, request.tmdbId, request.season || "", request.episode || "", request.imdbId || "", languages.join(",")].join(":");
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("subtitle provider timeout")), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export function createDefaultSubtitleGateway(): SubtitleGateway {
  return new SubtitleGateway([
    new OpenSubtitlesProvider(),
    new TvSubtitlesProvider(),
    new YifySubtitlesProvider(),
  ]);
}
