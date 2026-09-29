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

  private readonly baseUrls: string[];
  private readonly providerIds: string[];

  constructor(
    baseUrl = process.env.FLIXQUEST_API_URLS || process.env.FLIXQUEST_API_URL || "",
    providerIds = (process.env.FLIXQUEST_PROVIDER_IDS || "showbox")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ) {
    this.baseUrls = baseUrl
      .split(/[;,]/)
      .map((value) => value.trim().replace(/\/$/, ""))
      .filter((value, index, values) => /^https?:\/\//i.test(value) && values.indexOf(value) === index);
    this.providerIds = providerIds;
  }

  async resolve(req: ProviderRequest): Promise<PlayableSource[]> {
    if (!this.kinds.includes(req.kind as any)) return [];

    const v2Path = req.kind === "movie" ? "stream-movie" : "stream-tv";
    const results = await Promise.allSettled(
      this.baseUrls.flatMap((baseUrl) => this.providerIds.map(async (providerId) => {
        const path = req.kind === "movie"
          ? `watch-movie?tmdbId=${req.tmdbId}&proxied=false`
          : `watch-tv?tmdbId=${req.tmdbId}&season=${req.season || 1}&episode=${req.episode || 1}&proxied=false`;
        const stableLocator = `tmdb:${req.tmdbId}:${req.season || 1}:${req.episode || 1}`;
        const v2Query = new URLSearchParams({
          tmdbId: String(req.tmdbId),
          full: "true",
          noProxy: "true",
          provider: providerId,
        });
        if (req.kind !== "movie") {
          v2Query.set("season", String(req.season || 1));
          v2Query.set("episode", String(req.episode || 1));
        }
        const parse = (body: any): PlayableSource[] => {
          if (!body) return [];
          const inheritedSubs = normalizeSubtitles(body?.subtitles || body?.tracks);
          return collectCandidates(body)
            .map((raw) => directFromUnknown(raw, `flixquest:${providerId}`, {
              subtitles: inheritedSubs,
              // Both the old and v2 APIs may return proxy URLs with an
              // expiry token. Keep the TMDB identity as the locator so the
              // source is refreshed JIT instead of persisting that token.
              canonicalLocator: stableLocator,
            }))
            .filter((source): source is PlayableSource => Boolean(source));
        };

        const legacy = parse(await fetchJson(`${baseUrl}/${encodeURIComponent(providerId)}/${path}`));
        if (legacy.length > 0) return legacy;

        // FlixQuest's current public contract moved under /api/v2 and returns
        // {links:[...]}. Keep the old route first for self-hosts that still
        // expose v1, then fall back to the documented v2 route without
        // making callers change their provider configuration.
        v2Query.set("provider", providerId);
        const v2Base = baseUrl.endsWith("/api/v2") ? baseUrl : `${baseUrl}/api/v2`;
        return parse(await fetchJson(`${v2Base}/${v2Path}?${v2Query.toString()}`));
      })),
    );

    const sources = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const seen = new Set<string>();
    return sources.filter((source) => {
      const key = `${source.provider}|${source.canonicalLocator || source.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
