import { fetchJson, directFromUnknown } from "./http";
import type { DirectStreamProvider, PlayableSource, ProviderRequest } from "./types";

export class NuvioClient implements DirectStreamProvider {
  readonly id = "nuvio";
  readonly kinds = ["movie", "series"] as const;

  private readonly baseUrl: string;

  constructor(baseUrl = process.env.NUVIO_STREAMS_URL || "https://nuviostreams.hayd.uk") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async resolve(req: ProviderRequest): Promise<PlayableSource[]> {
    if (!this.kinds.includes(req.kind as any)) return [];
    const type = req.kind === "movie" ? "movie" : "series";
    const ids = req.kind === "movie"
      ? [`tmdb:${req.tmdbId}`, String(req.tmdbId)]
      : [
          `tmdb:${req.tmdbId}:${req.season || 1}:${req.episode || 1}`,
          `${req.tmdbId}:${req.season || 1}:${req.episode || 1}`,
        ];

    for (const id of ids) {
      const body = await fetchJson(`${this.baseUrl}/stream/${type}/${encodeURIComponent(id)}.json`);
      const streams: unknown[] = Array.isArray(body?.streams) ? body.streams as unknown[] : [];
      const direct = streams
        .map((raw: any) => directFromUnknown(raw, `nuvio:${raw?.name || raw?.title || "stream"}`, {
          canonicalLocator: `tmdb:${req.tmdbId}:${req.season || 1}:${req.episode || 1}`,
        }))
        .filter((source: PlayableSource | null): source is PlayableSource => Boolean(source));
      if (direct.length > 0) return direct;
    }
    return [];
  }
}
