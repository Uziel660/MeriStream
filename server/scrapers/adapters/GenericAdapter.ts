import * as cheerio from "cheerio";
import { BaseScraperAdapter, COMMON_HEADERS } from "../BaseAdapter";
import { UniversalAnalysisResult, ContentKind, ExtractedEpisode, ExtractedCatalogItem } from "../../types";
import { cleanQueryTitle, enrichUniversalMetadata } from "../../metadataEngine";
import { PageClassifier } from "../../pageClassifier";
import { MediaValidator } from "../../validator";

export class GenericAdapter extends BaseScraperAdapter {
  readonly id = "generic";
  readonly name = "Universal Semantic Scraper (Fallback)";
  readonly supportedDomains = ["* (Universal Fallback)"];

  canHandle(_url: string): boolean {
    return true; // Handles everything as fallback
  }

  async analyze(input: string, explicitType?: "auto" | "catalog" | "detail" | "stream"): Promise<UniversalAnalysisResult> {
    const urlOrQuery = input.trim();

    // 1. If it's a search term
    if (!urlOrQuery.startsWith("http://") && !urlOrQuery.startsWith("https://")) {
      return this.handleSearchTerm(urlOrQuery);
    }

    try {
      const urlObj = new URL(urlOrQuery);
      const domain = urlObj.hostname.toLowerCase();

      const html = await this.fetchHtml(urlOrQuery);
      if (!html) {
        return this.handleSearchTerm(urlOrQuery);
      }

      const $ = cheerio.load(html);

      // Extract OpenGraph & Meta Tags
      const ogTitle = $('meta[property="og:title"]').attr("content") || $('meta[name="twitter:title"]').attr("content") || $("title").text() || "";
      const ogDesc = $('meta[property="og:description"]').attr("content") || $('meta[name="twitter:description"]').attr("content") || $('meta[name="description"]').attr("content") || "";
      const ogImage = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || "";
      const ogVideo = $('meta[property="og:video"]').attr("content") || $('meta[property="og:video:url"]').attr("content") || "";

      // Extract JSON-LD
      const jsonLdData: any[] = [];
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const text = $(el).html();
          if (text) {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) jsonLdData.push(...parsed);
            else jsonLdData.push(parsed);
          }
        } catch {}
      });

      const schemaMedia = jsonLdData.find(
        (item) => item["@type"] === "Movie" || item["@type"] === "TVSeries" || item["@type"] === "TVEpisode" || item["@type"] === "VideoObject"
      );

      // Determine Content Kind
      let detectedKind: ContentKind = "anime";
      const pathAndTitle = (urlOrQuery + " " + ogTitle + " " + ogDesc).toLowerCase();

      if (domain.includes("anime") || pathAndTitle.includes("anime") || pathAndTitle.includes("manga")) {
        detectedKind = "anime";
      } else if (domain.includes("cuevana") || domain.includes("pelis") || pathAndTitle.includes("pelicula") || pathAndTitle.includes("movie") || schemaMedia?.["@type"] === "Movie") {
        detectedKind = "movie";
      } else if (pathAndTitle.includes("serie") || pathAndTitle.includes("temporada") || pathAndTitle.includes("season") || schemaMedia?.["@type"] === "TVSeries") {
        detectedKind = "series";
      }

      // Extract streams
      const detectedStreams = this.extractEmbedsAndStreamsFromHtml($, html, urlOrQuery);
      if (ogVideo && !detectedStreams.includes(ogVideo)) {
        detectedStreams.unshift(ogVideo);
      }

      // Extract episodes
      const extractedEpisodes: ExtractedEpisode[] = [];
      const episodeSelectors = [
        "ul.episodes-list li a", ".episodes-list a", "ul.ListCaps li a", ".ListCaps a",
        ".capitulos-list a", "table.episodes-table tr a", ".episode-item a",
        "a[href*='/ver/']", "a[href*='episodio']", "a[href*='capitulo']", "a[href*='watch']"
      ];

      for (const selector of episodeSelectors) {
        $(selector).each((idx, el) => {
          const rawText = $(el).text().trim() || $(el).attr("title") || `Episodio ${idx + 1}`;
          let href = $(el).attr("href") || "";
          if (href && !href.startsWith("http")) {
            try {
              href = new URL(href, urlOrQuery).toString();
            } catch {}
          }
          if (href && !extractedEpisodes.some((e) => e.url === href)) {
            const numMatch = rawText.match(/\b(?:episodio|capitulo|ep|cap)?\s*(\d+(?:\.\d+)?)\b/i) || href.match(/[-_](\d+(?:\.\d+)?)(?:\/|$|\.html)/i);
            const num = numMatch ? parseFloat(numMatch[1]) : idx + 1;
            extractedEpisodes.push({
              number: num,
              title: rawText.replace(/\s+/g, " "),
              url: href,
            });
          }
        });
        if (extractedEpisodes.length > 0) break;
      }

      // Extract catalog items
      const catalogItems: ExtractedCatalogItem[] = [];
      const seenCatalogUrls = new Set<string>();
      const cardSelectors = [
        "ul.ListAnimes > li", "article.anime", "article", ".anime-card", ".item", ".film", ".card",
        "li.anime", "ul.animes > li", ".list-animes > li", ".grid > div", ".catalog-grid > div",
        ".row > div", ".post", ".hentry", ".ht_grid_1_4", ".type-post", ".browse-item", ".catalog-card"
      ];

      let cards = $([]);
      for (const selector of cardSelectors) {
        const found = $(selector);
        if (found.length >= 3) {
          cards = found;
          break;
        }
      }

      cards.each((_, card) => {
        const anchors = $(card).find("a[href]");
        if (anchors.length === 0) return;

        const showUrl = this.extractShowUrlFromAnchors($, anchors, urlOrQuery, domain);
        if (!showUrl || seenCatalogUrls.has(showUrl)) return;

        const imgUrl = this.extractCardImgUrl($, card, urlOrQuery);
        const cardTitle = this.extractCatalogCardTitle($, card, anchors, showUrl);

        if (["inicio", "home", "directorio anime", "dmca", "contacto", "login"].some((b) => cardTitle.toLowerCase().includes(b))) {
          return;
        }

        seenCatalogUrls.add(showUrl);
        catalogItems.push({
          title: cleanQueryTitle(cardTitle),
          url: showUrl,
          image_url: imgUrl,
          kind: detectedKind,
        });
      });

      const classifiedType = PageClassifier.classify(urlOrQuery, $);
      const isCatalog = explicitType === "catalog" || (explicitType !== "detail" && (classifiedType === "collection" || (catalogItems.length >= 3 && extractedEpisodes.length === 0)));
      const pageType: UniversalAnalysisResult["page_type"] = isCatalog ? "catalog" : "detail";

      const validatedStreams = await MediaValidator.validateUrls(detectedStreams);
      const finalStreams = validatedStreams.length > 0 ? validatedStreams : detectedStreams;

      if (isCatalog) {
        const catalogTitle = ogTitle || `Catálogo (${domain})`;
        const catalogPoster = this.resolveRelativeUrl(ogImage, urlOrQuery) || (catalogItems[0]?.image_url || null);

        return {
          page_type: "catalog",
          content_type: detectedKind,
          title: catalogTitle,
          description: ogDesc || `Directorio de ${catalogItems.length} obras multimedia detectadas en ${domain}.`,
          poster_url: catalogPoster,
          banner_url: catalogPoster,
          rating: 8.5,
          year: new Date().getFullYear(),
          status: "Catálogo",
          genres: ["Directorio", "Catálogo"],
          source_domain: domain,
          detected_streams: [],
          episodes: [],
          catalog_items: catalogItems,
          raw_metadata: { og: { title: ogTitle, description: ogDesc, image: ogImage }, embeds: [] },
        };
      }

      const rawCleanTitle = cleanQueryTitle(schemaMedia?.name || ogTitle || urlObj.pathname.split("/").pop() || "Contenido");
      const enriched = await enrichUniversalMetadata(rawCleanTitle, detectedKind);

      let finalEpisodes = extractedEpisodes;
      if (finalEpisodes.length === 0) {
        if (detectedKind === "movie" || detectedKind === "open_archive") {
          finalEpisodes = [{ number: 1, title: "Película Completa", url: detectedStreams[0] || urlOrQuery }];
        } else if (detectedStreams.length > 0) {
          finalEpisodes = detectedStreams.map((st, idx) => ({ number: idx + 1, title: `Episodio ${idx + 1}`, url: st }));
        } else {
          finalEpisodes = [{ number: 1, title: "Episodio 1", url: urlOrQuery }];
        }
      }

      return {
        page_type: pageType,
        content_type: enriched.content_type || detectedKind,
        title: enriched.title || rawCleanTitle,
        original_title: enriched.original_title,
        japanese_title: enriched.japanese_title,
        english_title: enriched.english_title,
        description: enriched.description || ogDesc || "Contenido indexado en VoidStream.",
        poster_url: enriched.poster_url || this.resolveRelativeUrl(ogImage, urlOrQuery),
        banner_url: enriched.banner_url || this.resolveRelativeUrl(ogImage, urlOrQuery),
        rating: enriched.rating || 8.0,
        year: enriched.year || 2024,
        status: enriched.status || "Finalizado",
        genres: enriched.genres.length > 0 ? enriched.genres : ["Multimedia"],
        source_domain: domain,
        detected_streams: finalStreams,
        episodes: finalEpisodes,
        catalog_items: catalogItems,
        raw_metadata: { og: { title: ogTitle, description: ogDesc, image: ogImage }, embeds: finalStreams },
      };
    } catch {
      return this.handleSearchTerm(urlOrQuery);
    }
  }

  private resolveRelativeUrl(url: string | null | undefined, baseUrl: string): string | null {
    if (!url) return null;
    if (url.startsWith("http")) return url;
    if (url.startsWith("//")) return `https:${url}`;
    if (url.startsWith("/")) {
      try {
        const u = new URL(baseUrl);
        return `${u.origin}${url}`;
      } catch {
        return null;
      }
    }
    return url;
  }

  private async handleSearchTerm(query: string): Promise<UniversalAnalysisResult> {
    const cleaned = cleanQueryTitle(query);
    const enriched = await enrichUniversalMetadata(cleaned);
    const primaryUrl = `https://www3.animeflv.net/browse?q=${encodeURIComponent(cleaned)}`;

    const defaultEpisodes: ExtractedEpisode[] = (enriched.suggested_episodes && enriched.suggested_episodes.length > 0)
      ? enriched.suggested_episodes.map((s) => ({
          number: s.number,
          title: s.title,
          url: s.url || primaryUrl,
        }))
      : [{ number: 1, title: "Episodio 1", url: primaryUrl }];

    return {
      page_type: "detail",
      content_type: enriched.content_type || "anime",
      title: enriched.title || cleaned,
      original_title: enriched.original_title,
      japanese_title: enriched.japanese_title,
      english_title: enriched.english_title,
      description: enriched.description || `Resultados de búsqueda para '${query}'`,
      poster_url: enriched.poster_url || null,
      banner_url: enriched.banner_url || null,
      rating: enriched.rating || 8.0,
      year: enriched.year || 2024,
      status: enriched.status || "Finalizado",
      genres: enriched.genres || ["Multimedia"],
      episodes: defaultEpisodes,
      catalog_items: [],
    };
  }

  private extractShowUrlFromAnchors($: cheerio.CheerioAPI, anchors: cheerio.Cheerio<cheerio.Element>, urlOrQuery: string, domain: string): string | null {
    let showUrl: string | null = null;
    anchors.each((_, a) => {
      const href = ($(a).attr("href") || "").trim();
      if (!href) return;

      let fullUrl = href;
      if (!fullUrl.startsWith("http")) {
        try {
          fullUrl = new URL(href, urlOrQuery).toString();
        } catch {
          return;
        }
      }

      try {
        const parsed = new URL(fullUrl);
        if (parsed.hostname.toLowerCase() === domain) {
          const pathLower = parsed.pathname.toLowerCase();
          if (
            pathLower !== "" &&
            pathLower !== "/" &&
            pathLower !== "/home" &&
            pathLower !== "/inicio" &&
            !["/category/", "/genre/", "/tag/", "/page/", "/browse", "#", "javascript:"].some((b) => pathLower.includes(b))
          ) {
            showUrl = fullUrl;
            return false;
          }
        }
      } catch {}
    });
    return showUrl;
  }

  private extractCardImgUrl($: cheerio.CheerioAPI, card: cheerio.Element, urlOrQuery: string): string | null {
    const img = $(card).find("img").first();
    if (img.length === 0) return null;
    const imgSrc = img.attr("data-src") || img.attr("data-lazy-src") || img.attr("data-original") || img.attr("srcset") || img.attr("src") || "";
    if (!imgSrc) return null;
    const firstSrc = imgSrc.split(/\s+/)[0];
    try {
      return new URL(firstSrc, urlOrQuery).toString();
    } catch {
      if (firstSrc.startsWith("//")) return `https:${firstSrc}`;
      if (firstSrc.startsWith("/")) {
        try {
          const u = new URL(urlOrQuery);
          return `${u.origin}${firstSrc}`;
        } catch {
          return null;
        }
      }
      return firstSrc;
    }
  }

  private extractCatalogCardTitle($: cheerio.CheerioAPI, card: cheerio.Element, anchors: cheerio.Cheerio<cheerio.Element>, showUrl: string): string {
    const heading = $(card).find("h1, h2, h3, h4, h5, strong, .title, .entry-title").first();
    if (heading.length > 0 && heading.text().trim().length > 1) {
      return heading.text().trim();
    }

    const img = $(card).find("img").first();
    if (img.length > 0 && img.attr("alt")) {
      return img.attr("alt")!.trim();
    }

    let anchorTitle = "";
    anchors.each((_, a) => {
      const t = $(a).text().trim() || $(a).attr("title") || "";
      if (t.length > 1 && !["ver", "anime", "leer"].some((b) => t.toLowerCase().includes(b))) {
        anchorTitle = t;
        return false;
      }
    });
    if (anchorTitle) return anchorTitle;

    if (showUrl) {
      const parts = showUrl.replace(/\/$/, "").split("/");
      return parts[parts.length - 1].replace(/[-_]/g, " ");
    }

    return "";
  }
}
