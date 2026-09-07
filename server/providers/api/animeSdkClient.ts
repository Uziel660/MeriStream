import { fetchJson, directFromUnknown } from "./http";
import type { DirectStreamProvider, PlayableSource, ProviderRequest } from "./types";

function firstMetaId(body: any): string | null {
  const values = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : Array.isArray(body?.data) ? body.data : [];
  const first = values.find((item: any) => item?.id || item?.urn);
  return first ? String(first.id || first.urn) : null;
}

function extractVideoStreams(body: any, provider: string, canonicalLocator: string): PlayableSource[] {
  const values = Array.isArray(body?.streams) ? body.streams : Array.isArray(body) ? body : [];
  return values
    .map((raw: any) => directFromUnknown({
      ...raw,
      url: raw?.sourceUrl || raw?.url,
      subtitles: raw?.subtitles,
      headers: raw?.headers,
    }, provider, { canonicalLocator }))
    .filter((source): source is PlayableSource => Boolean(source));
}

export class AnimeSdkClient implements DirectStreamProvider {
  readonly id = "anime-sdk";
  readonly kinds = ["anime"] as const;

  private readonly baseUrl: string | null;
  private readonly contentProviders: string[];

  constructor(
    baseUrl = process.env.ANIME_SDK_URL || null,
    contentProviders = (process.env.ANIME_SDK_CONTENT_PROVIDERS || "megaplay,animeparadise,allmanga,gogoanime")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/, "") : null;
    this.contentProviders = contentProviders;
  }

  async resolve(req: ProviderRequest): Promise<PlayableSource[]> {
    if (req.kind !== "anime" || !this.baseUrl) return [];

    let metaId = req.anilistId ? `anilist:${req.anilistId}` : req.malId ? `mal:anime:${req.malId}` : null;
    if (!metaId && req.title) {
      const search = await fetchJson(`${this.baseUrl}/meta/search?provider=anilist&q=${encodeURIComponent(req.title)}`);
      metaId = firstMetaId(search);
    }
    if (!metaId) return [];

    const canonicalLocator = `${metaId}:${req.episode || 1}`;
    const resolved = await Promise.allSettled(
      this.contentProviders.flatMap((contentProvider) => ["sub", "dub"].map(async (language) => {
        const url = `${this.baseUrl}/meta/stream?provider=anilist&id=${encodeURIComponent(metaId!)}&episode=${req.episode || 1}&contentProvider=${encodeURIComponent(contentProvider)}&language=${language}`;
        const body = await fetchJson(url, {}, 8_000);
        if (!body || body?.type === "manga") return [] as PlayableSource[];
        return extractVideoStreams(body, `anime-sdk:${contentProvider}:${language}`, canonicalLocator).map((source) => ({
          ...source,
          audioLanguage: source.audioLanguage || (language === "dub" ? "en" : "ja"),
        }));
      })),
    );

    return resolved.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  }
}
