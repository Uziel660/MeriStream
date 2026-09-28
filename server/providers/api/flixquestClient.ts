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
    providerIds = (process.env.FLIXQUEST_PROVIDER_IDS || "showbox")
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

    const v2Path = req.kind === "movie" ? "stream-movie" : "stream-tv";
    const v2Query = new URLSearchParams({
      tmdbId: String(req.tmdbId),
      full: "true",
      noProxy: "true",
    });
    if (req.kind !== "movie") {
      v2Query.set("season", String(req.season || 1));
      v2Query.set("episode", String(req.episode || 1));
    }

    const results = await Promise.allSettled(
      this.providerIds.map(async (providerId) => {
        const stableLocator = `tmdb:${req.tmdbId}:${req.season || 1}:${req.episode || 1}`;
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

        const legacy = parse(await fetchJson(`${this.baseUrl}/${encodeURIComponent(providerId)}/${path}`));
        if (legacy.length > 0) return legacy;

        // FlixQuest's current public contract moved under /api/v2 and returns
        // {links:[...]}. Keep the old route first for self-hosts that still
        // expose v1, then fall back to the documented v2 route without
        // making callers change their provider configuration.
        v2Query.set("provider", providerId);
        const v2Base = this.baseUrl.endsWith("/api/v2") ? this.baseUrl : `${this.baseUrl}/api/v2`;
        return parse(await fetchJson(`${v2Base}/${v2Path}?${v2Query.toString()}`));
      }),
    );

    return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  }
}
