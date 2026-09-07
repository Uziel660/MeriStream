import { fetchJson, directFromUnknown } from "./http";
import type { DirectStreamProvider, PlayableSource, ProviderRequest } from "./types";

type IdMode = "tmdb" | "imdb";

interface AddonConfig {
  name: string;
  baseUrl: string;
  idMode: IdMode;
}

function parseConfiguredAddons(raw = process.env.STREMIO_DIRECT_ADDONS || ""): AddonConfig[] {
  return raw
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [nameRaw, baseRaw, idModeRaw] = entry.split("|").map((value) => value.trim());
      if (!nameRaw || !baseRaw || !/^https?:\/\//i.test(baseRaw)) return null;
      const idMode: IdMode = idModeRaw?.toLowerCase() === "imdb" ? "imdb" : "tmdb";
      return {
        name: nameRaw,
        baseUrl: baseRaw.replace(/\/(?:manifest\.json)?$/i, ""),
        idMode,
      } as AddonConfig;
    })
    .filter((value): value is AddonConfig => Boolean(value));
}

async function tmdbToImdb(req: ProviderRequest): Promise<string | null> {
  const key = process.env.TMDB_API_KEY;
  if (!key) return null;
  const mediaType = req.kind === "movie" ? "movie" : "tv";
  const body = await fetchJson(
    `https://api.themoviedb.org/3/${mediaType}/${req.tmdbId}/external_ids?api_key=${encodeURIComponent(key)}`,
  );
  const id = String(body?.imdb_id || "").trim();
  return /^tt\d+$/i.test(id) ? id : null;
}

function streamId(req: ProviderRequest, id: string): string {
  if (req.kind === "movie") return id;
  return `${id}:${req.season || 1}:${req.episode || 1}`;
}

function directStreams(body: any, addon: AddonConfig, locator: string): PlayableSource[] {
  const streams = Array.isArray(body?.streams) ? body.streams : [];
  return streams
    .map((raw: any) => directFromUnknown(
      {
        ...raw,
        url: raw?.url,
        headers: raw?.behaviorHints?.proxyHeaders?.request || raw?.headers,
      },
      `stremio:${addon.name}`,
      { canonicalLocator: locator },
    ))
    .filter((source): source is PlayableSource => Boolean(source));
}

/**
 * Generic Stremio direct-stream bridge.
 *
 * Config format:
 *   STREMIO_DIRECT_ADDONS=name|https://addon.example|tmdb;other|https://other.example|imdb
 *
 * Only `streams[].url` values that resolve to HLS/DASH/MP4 cross the primary
 * boundary. `externalUrl`, `ytId`, embeds and provider pages are ignored.
 */
export class StremioDirectClient implements DirectStreamProvider {
  readonly id = "stremio-direct";
  readonly kinds = ["movie", "series"] as const;

  async resolve(req: ProviderRequest): Promise<PlayableSource[]> {
    if (!this.kinds.includes(req.kind as any)) return [];
    const addons = parseConfiguredAddons();
    if (addons.length === 0) return [];

    const needsImdb = addons.some((addon) => addon.idMode === "imdb");
    const imdbId = needsImdb ? await tmdbToImdb(req) : null;

    const settled = await Promise.allSettled(addons.map(async (addon) => {
      const baseId = addon.idMode === "imdb" ? imdbId : `tmdb:${req.tmdbId}`;
      if (!baseId) return [] as PlayableSource[];
      const id = streamId(req, baseId);
      const types = req.kind === "movie" ? ["movie"] : ["series", "tv"];

      for (const type of types) {
        const body = await fetchJson(`${addon.baseUrl}/stream/${type}/${encodeURIComponent(id)}.json`);
        const sources = directStreams(body, addon, id);
        if (sources.length > 0) return sources;
      }
      return [] as PlayableSource[];
    }));

    return settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  }
}

export { parseConfiguredAddons };
