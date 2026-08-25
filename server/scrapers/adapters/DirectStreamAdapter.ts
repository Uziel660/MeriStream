import { BaseScraperAdapter } from "../BaseAdapter";
import { UniversalAnalysisResult } from "../../types";
import { cleanQueryTitle } from "../../metadataEngine";

export class DirectStreamAdapter extends BaseScraperAdapter {
  readonly id = "direct_stream";
  readonly name = "Direct Video / HLS Stream";
  readonly supportedDomains = ["* (Direct .m3u8, .mp4, .webm, .mkv)"];

  canHandle(url: string): boolean {
    const lower = url.trim().toLowerCase();
    return (
      lower.endsWith(".m3u8") ||
      lower.endsWith(".mp4") ||
      lower.endsWith(".webm") ||
      lower.endsWith(".mkv") ||
      lower.includes(".m3u8?") ||
      lower.includes(".mp4?") ||
      lower.includes("mux.dev/") ||
      lower.includes("commondatastorage.googleapis.com/")
    );
  }

  async analyze(input: string): Promise<UniversalAnalysisResult> {
    const streamUrl = input.trim();
    let title = "Stream de Video";
    try {
      const urlObj = new URL(streamUrl);
      const filename = urlObj.pathname.split("/").pop() || "";
      if (filename) {
        title = filename.replace(/\.(m3u8|mp4|webm|mkv)$/i, "").replace(/[-_]/g, " ");
      }
    } catch {}

    return {
      page_type: "direct_stream",
      content_type: "movie",
      title: cleanQueryTitle(title) || "Stream Multimedia",
      description: "Fuente de video directa indexada con compatibilidad HLS / MP4 nativa.",
      poster_url: null,
      banner_url: null,
      rating: 8.5,
      year: new Date().getFullYear(),
      status: "Directo",
      genres: ["Stream HLS", "Video HD"],
      detected_streams: [streamUrl],
      episodes: [
        {
          number: 1,
          title: "Reproducción Principal",
          url: streamUrl,
        },
      ],
      catalog_items: [],
    };
  }

  async extractStream(targetUrl: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const cleanUrl = targetUrl.trim();
    return {
      stream_url: cleanUrl,
      all_available_streams: [cleanUrl],
    };
  }
}
