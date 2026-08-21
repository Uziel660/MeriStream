import * as cheerio from "cheerio";
import { BaseScraperAdapter, COMMON_HEADERS } from "../BaseAdapter";
import { UniversalAnalysisResult, ExtractedEpisode, ExtractedCatalogItem } from "../../types";
import { cleanQueryTitle, enrichUniversalMetadata } from "../../metadataEngine";

export class TvMazeAdapter extends BaseScraperAdapter {
  readonly id = "tvmaze";
  readonly name = "TVMaze International Shows";
  readonly supportedDomains = ["tvmaze.com"];

  canHandle(url: string): boolean {
    return url.toLowerCase().includes("tvmaze.com");
  }

  async analyze(input: string, explicitType?: "auto" | "catalog" | "detail" | "stream"): Promise<UniversalAnalysisResult> {
    const cleanUrl = input.trim();
    const urlObj = new URL(cleanUrl);

    // If it is a direct show URL: https://www.tvmaze.com/shows/169/breaking-bad
    const showMatch = urlObj.pathname.match(/\/shows\/(\d+)/);
    if (showMatch) {
      const showId = showMatch[1];
      try {
        const apiRes = await fetch(`https://api.tvmaze.com/shows/${showId}?embed=episodes`, { headers: COMMON_HEADERS });
        if (apiRes.ok) {
          const data: any = await apiRes.json();
          const episodes: ExtractedEpisode[] = Array.isArray(data._embedded?.episodes)
            ? data._embedded.episodes.map((ep: any) => ({
                number: Number(ep.number) || Number(ep.season) || 1,
                title: ep.name ? `T${ep.season}E${ep.number}: ${ep.name}` : `Episodio ${ep.number || 1}`,
                url: ep.url || cleanUrl,
              }))
            : [];

          const title = cleanQueryTitle(data.name || "Serie TV");
          const desc = (data.summary || "").replace(/<[^>]+>/g, "").trim() || "Serie internacional indexada desde TVMaze.";
          const poster = data.image?.original || data.image?.medium || null;
          const rating = data.rating?.average ? Number(data.rating.average) : 8.5;
          const year = data.premiered ? parseInt(data.premiered.substring(0, 4), 10) : 2024;
          const genres = Array.isArray(data.genres) && data.genres.length > 0 ? data.genres : ["Drama", "Serie"];

          return {
            page_type: "detail",
            content_type: "series",
            title,
            original_title: data.name,
            english_title: data.name,
            description: desc,
            poster_url: poster,
            banner_url: poster,
            rating,
            year,
            status: data.status || "Finalizado",
            genres,
            source_domain: "tvmaze.com",
            detected_streams: [],
            episodes: episodes.length > 0 ? episodes : [{ number: 1, title: "Episodio 1", url: cleanUrl }],
            catalog_items: [],
          };
        }
      } catch {}
    }

    // Otherwise scrape HTML for catalog or shows
    const html = await this.fetchHtml(cleanUrl);
    if (!html) {
      const enriched = await enrichUniversalMetadata("TV Show", "series");
      return {
        page_type: "detail",
        content_type: "series",
        title: "TV Show",
        description: enriched.description || "",
        poster_url: enriched.poster_url || null,
        banner_url: enriched.banner_url || null,
        rating: enriched.rating || 8.0,
        year: enriched.year || 2024,
        status: "Finalizado",
        genres: ["Series"],
        episodes: [{ number: 1, title: "Episodio 1", url: cleanUrl }],
        catalog_items: [],
      };
    }

    const $ = cheerio.load(html);
    const catalogItems: ExtractedCatalogItem[] = [];

    $("a[href*='/shows/']").each((_, el) => {
      const href = $(el).attr("href");
      const title = $(el).text().trim();
      const img = $(el).find("img").attr("src");
      if (href && title && title.length > 2 && !catalogItems.some((i) => i.url.includes(href))) {
        catalogItems.push({
          title: cleanQueryTitle(title),
          url: href.startsWith("http") ? href : `https://www.tvmaze.com${href}`,
          image_url: img || null,
          kind: "series",
        });
      }
    });

    const isCatalog = explicitType === "catalog" || catalogItems.length >= 3;
    return {
      page_type: isCatalog ? "catalog" : "detail",
      content_type: "series",
      title: $("h1").first().text().trim() || "TVMaze Directory",
      description: $("article p").first().text().trim() || "Directorio de series internacionales TVMaze.",
      poster_url: catalogItems[0]?.image_url || null,
      banner_url: catalogItems[0]?.image_url || null,
      rating: 8.5,
      year: 2024,
      status: "Activo",
      genres: ["Series", "TV"],
      source_domain: "tvmaze.com",
      detected_streams: [],
      episodes: [],
      catalog_items: catalogItems,
    };
  }
}
