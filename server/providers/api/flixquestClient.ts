import { fetchJson, directFromUnknown, normalizeSubtitles } from "./http";
import type { DirectStreamProvider, PlayableSource, ProviderRequest } from "./types";

function collectCandidates(value: any, output: any[] = [], depth = 0): any[] {
  if (depth > 5 || value == null) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectCandidates(item, output, depth + 1);
    return output;
  }
  if (typeof value !== "object") return output;

  if (value.url || value.file || value.stream_url || value.streamUrl || value.src) output.push(value);
  for (const key of ["sources", "streams", "links", "data", "result", "qualities"]) {
    if (value[key] != null) collectCandidates(value[key], output, depth + 1);
  }
  return output;
}

export class FlixQuestClient implements DirectStreamProvider {
  readonly id = "flixquest";
  readonly kinds = ["movie", "series"] as const;

  private readonly baseUrl: string;
  private readonly providerIds: string[];

  constructor(
    baseUrl = process.env.FLIXQUEST_API_URL || "https://flixquest-api.vercel.app",
    providerIds = (process.env.FLIXQUEST_PROVIDER_IDS || "showbox,vidsrc,vidsrcto")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.providerIds = providerIds;
  }

  async resolve(req: ProviderRequest): Promise<PlayableSource[]> {
    if (!this.kinds.includes(req.kind as any)) return [];

    const path = req.kind === "movie"
      ? `watch-movie?tmdbId=${req.tmdbId}&proxied=false`
      : `watch-tv?tmdbId=${req.tmdbId}&season=${req.season || 1}&episode=${req.episode || 1}&proxied=false`;

    const results = await Promise.allSettled(
      this.providerIds.map(async (providerId) => {
        const body = await fetchJson(`${this.baseUrl}/${encodeURIComponent(providerId)}/${path}`);
        if (!body) return [] as PlayableSource[];
        const inheritedSubs = normalizeSubtitles(body?.subtitles || body?.tracks);
        return collectCandidates(body)
          .map((raw) => directFromUnknown(raw, `flixquest:${providerId}`, {
            subtitles: inheritedSubs,
            canonicalLocator: `tmdb:${req.tmdbId}:${req.season || 1}:${req.episode || 1}`,
          }))
          .filter((source): source is PlayableSource => Boolean(source));
      }),
    );

    return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  }
}
