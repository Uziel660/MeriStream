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
import { SubtitleCatProvider } from "./providers/SubtitleCatProvider";

const SEARCH_TTL_MS = Math.max(60 * 60_000, Number(process.env.SUBTITLE_SEARCH_CACHE_TTL_MS || 4 * 60 * 60_000));
const PROVIDER_TIMEOUT_MS = Math.max(1_000, Number(process.env.SUBTITLE_PROVIDER_TIMEOUT_MS || 8_000));

export function parseCandidateSeasonEpisode(text: string): { season?: number; episode?: number } | null {
  if (!text) return null;
  const clean = text.replace(/[()[\]{}]/g, " ");

  // 1. S01E02 / T03E01 / S1.E2 / T3.E01 / S01_E02 / T03.E01
  const seMatch = clean.match(/\b[st](\d{1,2})[\s._-]*(?:[ec]|ep|cap)(\d{1,3})(?!\d)/i);
  if (seMatch) {
    return { season: Number.parseInt(seMatch[1], 10), episode: Number.parseInt(seMatch[2], 10) };
  }

  // 2. 1x02 / 01x02 / 3x1
  const xMatch = clean.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (xMatch) {
    return { season: Number.parseInt(xMatch[1], 10), episode: Number.parseInt(xMatch[2], 10) };
  }

  // 3. Season 3 ... Episode 1 / Temporada 3 ... Capitulo 1 / Temp 3 ... Cap 1
  const verboseMatch = clean.match(/\b(?:season|temporada|temp)\s*(\d{1,2})[^0-9]{0,15}(?:episode|episodio|capitulo|cap|ep)\s*(\d{1,3})\b/i);
  if (verboseMatch) {
    return { season: Number.parseInt(verboseMatch[1], 10), episode: Number.parseInt(verboseMatch[2], 10) };
  }

  // 4. Standalone season or standalone episode
  const seasonOnly = clean.match(/\b(?:season|temporada|temp)\s*(\d{1,2})\b/i) || clean.match(/\b[st](\d{1,2})(?!\d)/i);
  const epOnly = clean.match(/\b(?:episode|episodio|capitulo|cap|ep)\s*(\d{1,3})\b/i) || clean.match(/\b[ec](\d{1,3})(?!\d)/i);
  if (seasonOnly || epOnly) {
    return {
      season: seasonOnly ? Number.parseInt(seasonOnly[1], 10) : undefined,
      episode: epOnly ? Number.parseInt(epOnly[1], 10) : undefined,
    };
  }

  return null;
}

function filterEpisodeCandidates(candidates: SubtitleCandidate[], request: SubtitleSearchRequest): SubtitleCandidate[] {
  if (request.season == null || request.episode == null) return candidates;
  const targetSeason = Math.max(1, request.season);
  const targetEpisode = Math.max(1, request.episode);

  return candidates.filter((candidate) => {
    const text = `${candidate.release || ""} ${candidate.label || ""} ${candidate.fileName || ""} ${candidate.sourceUrl || ""}`;
    const parsed = parseCandidateSeasonEpisode(text);
    if (!parsed) {
      // If there is no season/episode in candidate, accept only if requested season is 1
      return targetSeason === 1;
    }

    if (parsed.season !== undefined && parsed.season !== targetSeason) {
      return false;
    }
    if (parsed.episode !== undefined && parsed.episode !== targetEpisode) {
      return false;
    }

    return true;
  });
}

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
    const candidates = filterEpisodeCandidates(queried.candidates, request);
    if (!cached) this.searchCache.set(cacheKey, candidates, SEARCH_TTL_MS);

    const ranked = rankSubtitleCandidates(dedupeSubtitleCandidates(candidates), languages, 3);
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
    new SubtitleCatProvider(),
  ]);
}
