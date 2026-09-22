import { BaseScraperAdapter } from "../BaseAdapter";
import type { UniversalAnalysisResult } from "../../types";
import { EmbedResolvers } from "../../resolvers";
import { isZokoAnimeUrl, resolveZokoAnime } from "../../resolvers/zokoanimeResolver";

/**
 * Adapter for ZokoAnime's public stream locator.
 *
 * ZokoAnime does not expose a catalog contract that MeriStream can rely on;
 * this adapter is intentionally limited to the public `/stream/...` page and
 * turns its player payload into a native HLS/DASH/MP4 locator. It never returns
 * the player page as a playback URL.
 */
export class ZokoAnimeAdapter extends BaseScraperAdapter {
  readonly id = "zokoanime";
  readonly name = "ZokoAnime (JA + subtítulos ES)";
  readonly supportedDomains = ["zokoanime.video"];

  canHandle(url: string): boolean {
    return isZokoAnimeUrl(url);
  }

  async analyze(input: string): Promise<UniversalAnalysisResult> {
    const locator = input.trim();
    const resolution = await resolveZokoAnime(locator);
    const direct = resolution.url && EmbedResolvers.isDirectMediaUrl(resolution.url)
      ? resolution.url
      : undefined;
    const title = resolution.title || "ZokoAnime";
    const subtitles = resolution.subtitles.map((track, index) => ({
      id: `zoko-sub-${index}`,
      label: track.label || track.lang || "Subtítulos",
      language: track.lang,
      src: track.src,
      is_default: track.default === true,
    }));

    return {
      page_type: direct ? "detail" : "embed",
      content_type: "anime",
      title,
      description: "Reproductor público ZokoAnime con audio japonés y subtítulos disponibles.",
      poster_url: null,
      banner_url: null,
      rating: 0,
      year: 0,
      status: direct ? "Disponible" : "Sin stream directo",
      genres: ["Anime", "Japonés", "Subtítulos"],
      source_domain: "zokoanime.video",
      detected_streams: direct ? [direct] : undefined,
      episodes: [{
        number: 1,
        title,
        url: locator,
        server_name: "ZokoAnime",
        sources: direct ? [{
          url: direct,
          source_site: "zokoanime",
          link_type: "direct",
          host: new URL(direct).hostname,
          is_verified: true,
          audio_language: "ja",
          subtitle_language: subtitles[0]?.language || "es",
          subtitles,
        }] : [],
      }],
      catalog_items: [],
      raw_metadata: { embeds: [locator] },
    };
  }

  async extractStream(targetUrl: string): Promise<{
    stream_url: string;
    all_available_streams: string[];
    title?: string;
  }> {
    const result = await resolveZokoAnime(targetUrl);
    const stream = result.url && EmbedResolvers.isDirectMediaUrl(result.url) ? result.url : "";
    return {
      stream_url: stream,
      all_available_streams: stream ? [stream] : [],
      title: result.title,
    };
  }
}
