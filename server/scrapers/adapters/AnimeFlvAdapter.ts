import * as cheerio from "cheerio";
import { BaseScraperAdapter } from "../BaseAdapter";
import { UniversalAnalysisResult, ExtractedEpisode, ExtractedCatalogItem } from "../../types";
import { cleanQueryTitle, enrichUniversalMetadata } from "../../metadataEngine";
import { PageClassifier } from "../../pageClassifier";
import { MediaValidator } from "../../validator";
import { EmbedResolvers } from "../../resolvers";

export class AnimeFlvAdapter extends BaseScraperAdapter {
  readonly id = "animeflv";
  readonly name = "AnimeFLV / Anime Streaming";
  readonly supportedDomains = ["animeflv.net", "animeflv.or.at", "animeflv.me", "animeflv.ac", "animeflv.to", "jkanime.net"];

  canHandle(url: string): boolean {
    const lower = url.toLowerCase();
    return (
      lower.includes("animeflv.") ||
      lower.includes("jkanime.")
    );
  }

  async analyze(input: string, explicitType?: "auto" | "catalog" | "detail" | "stream"): Promise<UniversalAnalysisResult> {
    const urlOrQuery = input.trim();
    const urlObj = new URL(urlOrQuery);
    const domain = urlObj.hostname.toLowerCase();

    const html = await this.fetchHtml(urlOrQuery);
    if (!html) {
      return this.fallbackSearch(urlOrQuery);
    }

    const $ = cheerio.load(html);

    // 1. OpenGraph & Meta Tags
    const ogTitle = $('meta[property="og:title"]').attr("content") || $('meta[name="twitter:title"]').attr("content") || $("title").text() || "";
    const ogDesc = $('meta[property="og:description"]').attr("content") || $('meta[name="twitter:description"]').attr("content") || $('meta[name="description"]').attr("content") || "";
    const ogImage = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || "";

    // 2. Extract Streams from AnimeFLV JavaScript `var videos = ...` or DOM
    const detectedStreams = this.extractAnimeflvStreams($, html, urlOrQuery);

    // 3. Extract Episodes from AnimeFLV JavaScript `var anime_info` / `var episodes` or DOM
    const extractedEpisodes = this.extractAnimeflvEpisodes($, html, urlObj);

    // 4. Extract Catalog Items
    const catalogItems: ExtractedCatalogItem[] = [];
    const seenUrls = new Set<string>();

    const cardSelectors = [
      "ul.ListAnimes > li",
      "article.anime",
      "article",
      ".anime-card",
      ".item",
      ".film",
      ".card",
      "li.anime",
      "ul.animes > li",
      ".list-animes > li",
      ".ht_grid_1_4",
      ".post",
      ".hentry",
      ".type-post",
      ".List-Episodes > div",
      ".listCats > div",
      ".browse-item"
    ];

    let cards = $([]);
    for (const selector of cardSelectors) {
      const found = $(selector);
      if (found.length >= 3) {
        cards = found;
        break;
      }
    }

    if (cards.length === 0) {
      for (const selector of cardSelectors) {
        const found = $(selector);
        if (found.length > 0) {
          cards = found;
          break;
        }
      }
    }

    cards.each((_, card) => {
      const item = this.extractAnimeflvCard($, card, urlObj.origin);
      if (item && !seenUrls.has(item.url)) {
        seenUrls.add(item.url);
        catalogItems.push(item);
      }
    });

    const classifiedType = PageClassifier.classify(urlOrQuery, $);
    const isCatalog =
      explicitType === "catalog" ||
      (explicitType !== "detail" &&
        (classifiedType === "collection" ||
          (catalogItems.length >= 3 && extractedEpisodes.length === 0) ||
          urlOrQuery.includes("/page/") ||
          urlOrQuery.includes("?page=")));

    const pageType: UniversalAnalysisResult["page_type"] = isCatalog ? "catalog" : "detail";

    // Validate streams
    const validatedStreams = await MediaValidator.validateUrls(detectedStreams);
    const finalStreams = validatedStreams.length > 0 ? validatedStreams : detectedStreams;

    if (isCatalog) {
      const catalogPoster = ogImage ? (ogImage.startsWith("//") ? `https:${ogImage}` : ogImage) : (catalogItems[0]?.image_url || null);
      return {
        page_type: "catalog",
        content_type: "anime",
        title: ogTitle || `Catálogo Anime (${domain})`,
        description: ogDesc || `Directorio de ${catalogItems.length} animes en ${domain}.`,
        poster_url: catalogPoster,
        banner_url: catalogPoster,
        rating: 8.8,
        year: new Date().getFullYear(),
        status: "Catálogo",
        genres: ["Anime", "Catálogo"],
        source_domain: domain,
        detected_streams: [],
        episodes: [],
        catalog_items: catalogItems,
        raw_metadata: { og: { title: ogTitle, description: ogDesc, image: ogImage }, embeds: [] },
      };
    }

    // Detail page
    const rawCleanTitle = cleanQueryTitle($("h1.Title, h1.entry-title, h1").first().text().trim() || ogTitle || urlObj.pathname.split("/").filter(Boolean).pop() || "Anime");
    const enriched = await enrichUniversalMetadata(rawCleanTitle, "anime");

    let finalEpisodes = extractedEpisodes;
    if (finalEpisodes.length === 0) {
      if (detectedStreams.length > 0) {
        finalEpisodes = detectedStreams.map((st, idx) => ({
          number: idx + 1,
          title: `Episodio ${idx + 1}`,
          url: st,
        }));
      } else {
        finalEpisodes = [{ number: 1, title: "Episodio 1", url: urlOrQuery }];
      }
    }

    return {
      page_type: pageType,
      content_type: "anime",
      title: enriched.title || rawCleanTitle,
      original_title: enriched.original_title,
      japanese_title: enriched.japanese_title,
      english_title: enriched.english_title,
      description: enriched.description || ogDesc || "Serie de anime indexada desde AnimeFLV.",
      poster_url: enriched.poster_url || (ogImage ? (ogImage.startsWith("//") ? `https:${ogImage}` : ogImage) : null),
      banner_url: enriched.banner_url || (ogImage ? (ogImage.startsWith("//") ? `https:${ogImage}` : ogImage) : null),
      rating: enriched.rating || 8.5,
      year: enriched.year || 2024,
      status: enriched.status || "En emisión",
      genres: enriched.genres.length > 0 ? enriched.genres : ["Anime", "Animación"],
      source_domain: domain,
      detected_streams: finalStreams,
      episodes: finalEpisodes,
      catalog_items: catalogItems,
      raw_metadata: { og: { title: ogTitle, description: ogDesc, image: ogImage }, embeds: finalStreams },
    };
  }

  async extractStream(url: string): Promise<{ stream_url: string; all_available_streams: string[] }> {
    const html = await this.fetchHtml(url);
    if (!html) throw new Error("No se pudo obtener el contenido del episodio de AnimeFLV");

    const $ = cheerio.load(html);
    const rawStreams = this.extractAnimeflvStreams($, html, url);

    if (rawStreams.length === 0) {
      throw new Error("No se encontraron servidores de video en este episodio.");
    }

    const resolvedStreams: string[] = [];
    for (const st of rawStreams) {
      const resolved = await EmbedResolvers.resolve(st);
      if (resolved && !resolvedStreams.includes(resolved)) {
        resolvedStreams.push(resolved);
      }
      if (!resolvedStreams.includes(st)) {
        resolvedStreams.push(st);
      }
    }

    const validStreams = await MediaValidator.validateUrls(resolvedStreams);
    const finalStreams = validStreams.length > 0 ? validStreams : resolvedStreams;

    return {
      stream_url: finalStreams[0],
      all_available_streams: finalStreams,
    };
  }

  private extractAnimeflvStreams($: cheerio.CheerioAPI, html: string, baseUrl: string): string[] {
    const streams: string[] = [];
    const videoObjectMatch = html.match(/var\s+videos\s*=\s*(\{.+?\});/s);
    if (videoObjectMatch) {
      try {
        const parsed = JSON.parse(videoObjectMatch[1]);
        const servers = parsed.SUB || parsed.LAT || parsed.ENG || Object.values(parsed)[0] || [];
        if (Array.isArray(servers)) {
          servers.forEach((srv: any) => {
            if (srv.code && typeof srv.code === "string") {
              const cleanCode = srv.code.replace(/\\/g, "");
              if (!streams.includes(cleanCode)) streams.push(cleanCode);
            } else if (srv.url && typeof srv.url === "string") {
              if (!streams.includes(srv.url)) streams.push(srv.url);
            }
          });
        }
      } catch {}
    }

    const standardStreams = this.extractEmbedsAndStreamsFromHtml($, html, baseUrl);
    standardStreams.forEach((st) => {
      if (!streams.includes(st)) streams.push(st);
    });

    return streams;
  }

  private extractAnimeflvEpisodes($: cheerio.CheerioAPI, html: string, urlObj: URL): ExtractedEpisode[] {
    const extractedEpisodes: ExtractedEpisode[] = [];

    // 1. WordPress (animeflv.or.at / custom themes) JSON embedded episodes
    const epDataElement = $(".animeflv-episodes-data");
    if (epDataElement.length > 0) {
      try {
        const epData = JSON.parse(epDataElement.text().trim() || "[]");
        if (Array.isArray(epData)) {
          const sorted = [...epData].sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
          sorted.forEach((ep) => {
            if (ep.permalink) {
              extractedEpisodes.push({
                number: Number(ep.number) || 1,
                title: `Episodio ${ep.number || 1}`,
                url: ep.permalink,
              });
            }
          });
        }
      } catch {}
    }

    if (extractedEpisodes.length > 0) {
      return extractedEpisodes;
    }

    const scriptTexts: string[] = [];
    $("script").each((_, el) => {
      const content = $(el).html() || "";
      if (content) scriptTexts.push(content);
    });
    const allScripts = scriptTexts.join("\n");

    const animeInfoMatch = allScripts.match(/var\s+anime_info\s*=\s*(\[[^;]+\]);/);
    const episodesMatch = allScripts.match(/var\s+episodes\s*=\s*(\[[^;]+\]);/);

    if (episodesMatch) {
      try {
        const epData = JSON.parse(episodesMatch[1]);
        let animeSlug = "";
        if (animeInfoMatch) {
          try {
            const info = JSON.parse(animeInfoMatch[1]);
            animeSlug = info[1] || "";
          } catch {}
        }
        if (!animeSlug) {
          const parts = urlObj.pathname.split("/").filter(Boolean);
          animeSlug = parts[parts.length - 1] || "anime";
        }

        if (Array.isArray(epData)) {
          const sorted = [...epData].sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0));
          sorted.forEach((ep) => {
            const epNum = ep[0];
            const epUrl = `https://${urlObj.host}/ver/${animeSlug}-${epNum}`;
            extractedEpisodes.push({
              number: Number(epNum) || 1,
              title: `Episodio ${epNum}`,
              url: epUrl,
            });
          });
        }
      } catch {}
    }

    if (extractedEpisodes.length === 0) {
      $("ul.episodes-list li a, .ListCaps a, ul.ListCaps li a, .capitulos-list a, .episode-list a").each((idx, el) => {
        const rawText = $(el).text().trim() || $(el).attr("title") || `Episodio ${idx + 1}`;
        let href = $(el).attr("href") || "";
        if (href && !href.startsWith("http")) {
          try {
            href = new URL(href, `https://${urlObj.host}`).toString();
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
    }

    return extractedEpisodes;
  }

  private extractAnimeflvCard($: cheerio.CheerioAPI, card: cheerio.Element, baseUrl: string): ExtractedCatalogItem | null {
    const animeAnchor = $(card).find("a.thumbnail-link, a[href*='/anime/'], h2.entry-title a, h3 a, h2 a, a[href]").first();
    if (animeAnchor.length === 0) return null;

    const href = (animeAnchor.attr("href") || "").trim();
    if (!href || href === "#" || href.startsWith("javascript:")) return null;

    let fullUrl = href;
    if (!fullUrl.startsWith("http")) {
      try {
        fullUrl = new URL(href, baseUrl).toString();
      } catch {
        return null;
      }
    }

    const img = $(card).find("img.anime-image, img").first();
    let imgUrl: string | null = null;
    if (img.length > 0) {
      const imgSrc =
        img.attr("data-src") ||
        img.attr("data-cfsrc") ||
        img.attr("data-lazy-src") ||
        img.attr("data-original") ||
        img.attr("srcset") ||
        img.attr("src") ||
        "";
      if (imgSrc) {
        const firstSrc = imgSrc.split(/\s+/)[0];
        try {
          imgUrl = new URL(firstSrc, baseUrl).toString();
        } catch {
          imgUrl = firstSrc.startsWith("//") ? `https:${firstSrc}` : firstSrc;
        }
      }
    }

    let cardTitle = "";
    const heading = $(card).find("h1, h2, h3, h4, h5, strong, .entry-title, .Title, .title").first();
    if (heading.length > 0 && heading.text().trim().length > 1) {
      cardTitle = heading.text().trim();
    }
    if (!cardTitle && img.length > 0 && img.attr("alt")) {
      cardTitle = img.attr("alt")!.trim();
    }
    if (!cardTitle) {
      cardTitle = animeAnchor.text().trim() || animeAnchor.attr("title") || "";
    }

    const lowerTitle = cardTitle.toLowerCase();
    if (
      !cardTitle ||
      !fullUrl ||
      ["inicio", "home", "directorio anime", "dmca", "contacto", "login", "terms of service", "skip to content"].some((b) => lowerTitle.includes(b))
    ) {
      return null;
    }

    return {
      title: cleanQueryTitle(cardTitle),
      url: fullUrl,
      image_url: imgUrl,
      kind: "anime",
    };
  }

  private async fallbackSearch(query: string): Promise<UniversalAnalysisResult> {
    const cleaned = cleanQueryTitle(query);
    const enriched = await enrichUniversalMetadata(cleaned, "anime");
    return {
      page_type: "detail",
      content_type: "anime",
      title: enriched.title || cleaned,
      description: enriched.description || `Búsqueda para '${query}'`,
      poster_url: enriched.poster_url || null,
      banner_url: enriched.banner_url || null,
      rating: enriched.rating || 8.0,
      year: enriched.year || 2024,
      status: enriched.status || "Finalizado",
      genres: enriched.genres || ["Anime"],
      episodes: [{ number: 1, title: "Episodio 1", url: `https://www3.animeflv.net/browse?q=${encodeURIComponent(cleaned)}` }],
      catalog_items: [],
    };
  }
}
