import * as cheerio from "cheerio";
import { BaseScraperAdapter, COMMON_HEADERS } from "../BaseAdapter";
import { UniversalAnalysisResult, ExtractedCatalogItem } from "../../types";
import { cleanQueryTitle } from "../../metadataEngine";
import { PageClassifier } from "../../pageClassifier";

export class LaMovieAdapter extends BaseScraperAdapter {
  readonly id = "lamovie";
  readonly name = "LaMovie (Peliculas, Series, Animes)";
  readonly supportedDomains = ["lamovie.org"];

  canHandle(url: string): boolean {
    return url.toLowerCase().includes("lamovie.org");
  }

  async analyze(input: string, explicitType?: "auto" | "catalog" | "detail" | "stream"): Promise<UniversalAnalysisResult> {
    const cleanUrl = input.trim();
    const urlObj = new URL(cleanUrl);

    const html = await this.fetchHtml(cleanUrl);
    if (!html) {
      throw new Error("No se pudo obtener el contenido de LaMovie.");
    }

    const $ = cheerio.load(html);
    const catalogItems: ExtractedCatalogItem[] = [];

    $(".popular-card").each((_, el) => {
      const card = $(el);
      const link = card.find(".play-link").attr("href") || "";
      const fullUrl = link.startsWith("http") ? link : `https://lamovie.org${link}`;

      const titleOriginal = card.find(".original-title").text().trim();
      const titleTranslated = card.find(".translated-title").text().trim();
      // If we don't find the inner ones, default back
      const rawTitle = titleOriginal || titleTranslated || link.split('/').filter(Boolean).pop() || "Contenido";
      const cleanTitle = cleanQueryTitle(rawTitle);

      const img = card.find("img").attr("src") || null;

      let kind = "movie";
      if (fullUrl.includes("/series/")) {
        kind = "series";
      } else if (fullUrl.includes("/animes/")) {
        kind = "anime";
      }

      if (fullUrl && !catalogItems.some((i) => i.url === fullUrl)) {
        catalogItems.push({
          title: cleanTitle,
          url: fullUrl,
          image_url: img,
          kind,
        });
      }
    });

    // Check if the current page is catalog
    const classifiedType = PageClassifier.classify(cleanUrl, $);
    const isCatalog = explicitType === "catalog" || urlObj.pathname === "/peliculas" || urlObj.pathname === "/series" || urlObj.pathname === "/animes" || urlObj.pathname === "/" || (catalogItems.length >= 3 && explicitType !== "detail");

    if (isCatalog) {
      return {
        page_type: "catalog",
        content_type: "mixed",
        title: $("title").text().trim() || "LaMovie Catálogo",
        description: "Catálogo de películas, series y animes de LaMovie.",
        poster_url: catalogItems[0]?.image_url || null,
        banner_url: catalogItems[0]?.image_url || null,
        rating: 8.0,
        year: new Date().getFullYear(),
        status: "Catálogo",
        genres: ["Directorio"],
        source_domain: "lamovie.org",
        detected_streams: [],
        episodes: [],
        catalog_items: catalogItems,
      };
    }

    // Detail view
    const titleOriginal = $(".popular-card__title .original-title").first().text().trim() || $("h1").first().text().trim();
    const titleTranslated = $(".popular-card__title .translated-title").first().text().trim();
    const title = titleTranslated || titleOriginal || "Detalles";
    const imgUrl = $(".popular-card img").first().attr("src") || null;

    // Ratings, year
    let rating = 8.0;
    const imdbScore = $(".imdb-score").first().text().trim();
    if (imdbScore) {
      rating = parseFloat(imdbScore);
    }
    const yearStr = $(".rates .year").first().text().trim();
    const year = yearStr ? parseInt(yearStr, 10) : 2024;

    const streamMatches = this.extractEmbedsAndStreamsFromHtml($, html, cleanUrl);

    // Handle kinds for detail
    let contentType = "movie";
    if (urlObj.pathname.includes("/series/")) {
      contentType = "series";
    } else if (urlObj.pathname.includes("/animes/")) {
      contentType = "anime";
    }

    return {
      page_type: "detail",
      content_type: contentType,
      title: cleanQueryTitle(title),
      original_title: titleOriginal,
      description: `Ver ${title} en LaMovie`,
      poster_url: imgUrl,
      banner_url: imgUrl,
      rating,
      year,
      status: "Finalizado",
      genres: [contentType.toUpperCase()],
      source_domain: "lamovie.org",
      detected_streams: streamMatches,
      episodes: streamMatches.length > 0 ? streamMatches.map((url, idx) => ({
        number: idx + 1,
        title: `Video ${idx + 1}`,
        url
      })) : [{ number: 1, title: "Video", url: cleanUrl }],
      catalog_items: [],
    };
  }
}
