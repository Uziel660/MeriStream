import { BaseScraperAdapter, COMMON_HEADERS } from "../BaseAdapter";
import { UniversalAnalysisResult } from "../../types";
import { cleanQueryTitle } from "../../metadataEngine";

export class ArchiveOrgAdapter extends BaseScraperAdapter {
  readonly id = "archive_org";
  readonly name = "Internet Archive (Archive.org)";
  readonly supportedDomains = ["archive.org"];

  canHandle(url: string): boolean {
    return url.toLowerCase().includes("archive.org/details/");
  }

  async analyze(input: string): Promise<UniversalAnalysisResult> {
    const archiveUrl = input.trim();
    const match = archiveUrl.match(/archive\.org\/details\/([^/?#]+)/);
    const identifier = match ? match[1] : "";

    let title = identifier.replace(/[-_]/g, " ");
    let desc = "Película o archivo de libre distribución en Internet Archive.";
    const poster = identifier ? `https://archive.org/services/img/${identifier}` : null;
    const detectedStreams: string[] = [];

    if (identifier) {
      try {
        const metaRes = await fetch(`https://archive.org/metadata/${identifier}`, { headers: COMMON_HEADERS });
        if (metaRes.ok) {
          const metaData: any = await metaRes.json();
          if (metaData.metadata) {
            title = metaData.metadata.title || title;
            desc = metaData.metadata.description || desc;
          }
          if (Array.isArray(metaData.files)) {
            metaData.files.forEach((f: any) => {
              const name: string = f.name || "";
              if (name.endsWith(".mp4") || name.endsWith(".m3u8") || name.endsWith(".ogv")) {
                detectedStreams.push(`https://archive.org/download/${identifier}/${encodeURIComponent(name)}`);
              }
            });
          }
        }
      } catch {}
    }

    if (detectedStreams.length === 0 && identifier) {
      detectedStreams.push(`https://archive.org/download/${identifier}/${identifier}.mp4`);
    }

    return {
      page_type: "detail",
      content_type: "open_archive",
      title: cleanQueryTitle(title),
      description: desc,
      poster_url: poster,
      banner_url: poster,
      rating: 8.2,
      year: 1968,
      status: "Dominio Público",
      genres: ["Cine Clásico", "Dominio Público", "Película"],
      detected_streams: detectedStreams,
      episodes: [
        {
          number: 1,
          title: "Película Completa",
          url: detectedStreams[0] || archiveUrl,
        },
      ],
      catalog_items: [],
    };
  }

  async extractStream(targetUrl: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const res = await this.analyze(targetUrl);
    const streams = res.detected_streams || [];
    return {
      stream_url: streams[0] || targetUrl,
      all_available_streams: streams.length > 0 ? streams : [targetUrl],
      title: res.title,
    };
  }
}
