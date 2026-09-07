import { fetchJson, directFromUnknown } from "./http";
import type { DirectStreamProvider, PlayableSource, ProviderRequest } from "./types";

export class StreamProviderClient implements DirectStreamProvider {
  readonly id = "streamprovider";
  readonly kinds = ["movie", "series"] as const;
  private readonly baseUrl: string | null;

  constructor(baseUrl = process.env.STREAM_PROVIDER_URL || null) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/, "") : null;
  }

  async resolve(req: ProviderRequest): Promise<PlayableSource[]> {
    if (!this.baseUrl || !this.kinds.includes(req.kind as any)) return [];
    const url = new URL(this.baseUrl);
    url.searchParams.set("tmdbId", String(req.tmdbId));
    if (req.kind === "series") {
      url.searchParams.set("season", String(req.season || 1));
      url.searchParams.set("episode", String(req.episode || 1));
    }
    const body = await fetchJson(url.toString());
    const candidates = Array.isArray(body) ? body : [body?.stream, body?.data, body].filter(Boolean);
    return candidates
      .map((raw: any) => directFromUnknown(typeof raw === "string" ? { url: raw } : raw, "streamprovider", {
        canonicalLocator: `tmdb:${req.tmdbId}:${req.season || 1}:${req.episode || 1}`,
      }))
      .filter((source): source is PlayableSource => Boolean(source));
  }
}
