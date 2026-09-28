import { fetchJson, directFromUnknown } from "./http";
import type { DirectStreamProvider, PlayableSource, ProviderRequest } from "./types";
import { AllmangaProvider, AnimeParadiseProvider, GogoanimeProvider, HttpClient, MegaPlayProvider } from "anime-sdk";

function firstMetaId(body: any): string | null {
  const values = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : Array.isArray(body?.data) ? body.data : [];
  const first = values.find((item: any) => item?.id || item?.urn);
  return first ? String(first.id || first.urn) : null;
}

function extractVideoStreams(body: any, provider: string, canonicalLocator: string): PlayableSource[] {
  const values: unknown[] = Array.isArray(body?.streams)
    ? body.streams as unknown[]
    : Array.isArray(body)
      ? body as unknown[]
      : [];
  return values
    .map((raw: any) => directFromUnknown({
      ...raw,
      url: raw?.sourceUrl || raw?.url,
      subtitles: raw?.subtitles,
      headers: raw?.headers,
    }, provider, { canonicalLocator }))
    .filter((source: PlayableSource | null): source is PlayableSource => Boolean(source));
}

export class AnimeSdkClient implements DirectStreamProvider {
  readonly id = "anime-sdk";
  readonly kinds = ["anime"] as const;

  private readonly baseUrl: string | null;
  private readonly contentProviders: string[];
  private readonly localProviders: Array<{ id: string; search(query: string): Promise<any[]>; fetchContentUnits(id: string): Promise<any[]>; resolveStream(id: string, language?: "sub" | "dub"): Promise<any> }>;

  constructor(
    baseUrl = process.env.ANIME_SDK_URL || null,
    contentProviders = (process.env.ANIME_SDK_CONTENT_PROVIDERS || "megaplay,animeparadise,allmanga,gogoanime")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/, "") : null;
    this.contentProviders = contentProviders;
    if (this.baseUrl) {
      this.localProviders = [];
    } else {
      const http = new HttpClient({ timeoutMs: 8_000 });
      const providers = new Map<string, any>([
        ["megaplay", new MegaPlayProvider(http)],
        ["animeparadise", new AnimeParadiseProvider(http)],
        ["allmanga", new AllmangaProvider(http)],
        ["gogoanime", new GogoanimeProvider(http)],
      ]);
      this.localProviders = this.contentProviders
        .map((id) => providers.get(id))
        .filter((provider): provider is any => Boolean(provider));
    }
  }

  async resolve(req: ProviderRequest): Promise<PlayableSource[]> {
    if (req.kind !== "anime") return [];
    if (!this.baseUrl) return this.resolveLocal(req);

    const identityProvider = req.anilistId
      ? "anilist"
      : req.malId
        ? "mal"
        : req.kitsuId
          ? "kitsu"
          : "anilist";
    let metaId = req.anilistId
      ? `anilist:${req.anilistId}`
      : req.malId
        ? `mal:anime:${req.malId}`
        : req.kitsuId
          ? `kitsu:${req.kitsuId}`
          : null;
    if (!metaId && req.title) {
      const search = await fetchJson(`${this.baseUrl}/meta/search?provider=anilist&q=${encodeURIComponent(req.title)}`);
      metaId = firstMetaId(search);
    }
    if (!metaId) return [];

    const canonicalLocator = `${metaId}:${req.episode || 1}`;
    const resolved = await Promise.allSettled(
      this.contentProviders.flatMap((contentProvider) => ["sub", "dub"].map(async (language) => {
        const url = `${this.baseUrl}/meta/stream?provider=${identityProvider}&id=${encodeURIComponent(metaId!)}&episode=${req.episode || 1}&contentProvider=${encodeURIComponent(contentProvider)}&language=${language}`;
        const body = await fetchJson(url, {}, 8_000);
        if (!body || body?.type === "manga") return [] as PlayableSource[];
        return extractVideoStreams(body, `anime-sdk:${contentProvider}:${language}`, canonicalLocator).map((source: PlayableSource) => ({
          ...source,
          audioLanguage: source.audioLanguage || (language === "dub" ? "en" : "ja"),
        }));
      })),
    );

    return resolved.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  }

  /**
   * Use the published anime-sdk providers in-process when no remote API is
   * configured. This keeps the direct provider useful on a clean Oracle
   * install while preserving the existing HTTP contract as an override.
   * Returned stream URLs remain JIT-only; the stable locator is the provider
   * and episode identity, never the signed CDN URL.
   */
  private async resolveLocal(req: ProviderRequest): Promise<PlayableSource[]> {
    if (!req.title || this.localProviders.length === 0) return [];
    const episodeNumber = Math.max(1, Number(req.episode || 1));
    const settled = await Promise.allSettled(this.localProviders.map(async (provider) => {
      const matches = await provider.search(req.title!);
      for (const match of matches.slice(0, 4)) {
        const units = await provider.fetchContentUnits(match.id);
        const unit = units.find((candidate: any) => Math.abs(Number(candidate?.number) - episodeNumber) < 0.01) || units[episodeNumber - 1];
        if (!unit) continue;
        const canonicalLocator = `anime-sdk:${provider.id}:${match.id}:${episodeNumber}`;
        const sources: PlayableSource[] = [];
        for (const language of ["sub", "dub"] as const) {
          try {
            const resolved = await provider.resolveStream(unit.id, language);
            if (resolved?.type !== "video" || !Array.isArray(resolved.streams)) continue;
            for (const raw of resolved.streams) {
              const source = directFromUnknown({
                url: raw?.sourceUrl,
                type: raw?.isHLS ? "hls" : raw?.sourceUrl?.includes(".mp4") ? "mp4" : "dash",
                quality: raw?.quality,
                headers: raw?.headers,
                subtitles: raw?.subtitles,
                audioLanguage: language === "dub" ? "en" : "ja",
              }, `anime-sdk:${provider.id}:${language}`, { canonicalLocator });
              if (source) sources.push(source);
            }
          } catch {
            // One language/source can disappear while the other remains valid.
          }
        }
        if (sources.length > 0) return sources;
      }
      return [] as PlayableSource[];
    }));
    const seen = new Set<string>();
    return settled.flatMap((result) => result.status === "fulfilled" ? result.value : []).filter((source) => {
      const key = `${source.provider}|${source.canonicalLocator || source.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
