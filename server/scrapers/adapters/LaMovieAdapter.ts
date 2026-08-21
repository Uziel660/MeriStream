// server/scrapers/adapters/LaMovieAdapter.ts
import * as cheerio from "cheerio";
import { BaseScraperAdapter, COMMON_HEADERS } from "../BaseAdapter";
import { UniversalAnalysisResult, ExtractedCatalogItem } from "../../types";
import { cleanQueryTitle } from "../../metadataEngine";
import { PageClassifier } from "../../pageClassifier";
import { unpackGeneric, extractMediaUrlsFromCode } from "../utils/jsUnpacker";
import { EmbedResolvers } from "../../resolvers";
import { MediaValidator } from "../../validator";

export class LaMovieAdapter extends BaseScraperAdapter {
  readonly id = "lamovie";
  readonly name = "LaMovie (Peliculas, Series, Animes)";
  readonly supportedDomains = ["lamovie.org", "lamovie.to", "lamovie.ws", "la.movie"];

  canHandle(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.includes("lamovie.") || lower.includes("la.movie");
  }

  /**
   * Resuelve un iframe de reproductor (vimeos.net, goodstream.one, etc.)
   * desofuscando el script interno para extraer streams directos (.m3u8 / .mp4).
   */
  public async resolveIframeStream(iframeUrl: string, referer: string = "https://lamovie.org/"): Promise<string[]> {
    try {
      const html = await this.fetchHtml(iframeUrl, 7500, {
        Referer: referer,
        "User-Agent": COMMON_HEADERS["User-Agent"],
      });

      if (!html) return [];

      const streams: string[] = [];
      const $ = cheerio.load(html);

      // Inspeccionar todos los scripts embebidos en el HTML del iframe
      $("script").each((_, el) => {
        const scriptText = $(el).html() || "";
        if (!scriptText) return;

        const unpackedCode = unpackGeneric(scriptText);
        const extractedUrls = extractMediaUrlsFromCode(unpackedCode);

        extractedUrls.forEach((url) => {
          if (!streams.includes(url)) {
            streams.push(url);
          }
        });
      });

      // Si no se extrajo mediante scripts, buscar en todo el HTML desofuscado
      if (streams.length === 0) {
        const directUrls = extractMediaUrlsFromCode(html);
        directUrls.forEach((url) => {
          if (!streams.includes(url)) streams.push(url);
        });
      }

      return streams;
    } catch {
      return [];
    }
  }

  /**
   * Extrae streams en tiempo real de una película o episodio de LaMovie
   */
  async extractStream(targetUrl: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const cleanUrl = targetUrl.trim();
    const html = await this.fetchHtml(cleanUrl);

    if (!html) {
      throw new Error("No se pudo obtener el HTML de la página en LaMovie.");
    }

    const $ = cheerio.load(html);
    const title = $("h1").first().text().trim() || $("title").text().trim();

    // 1. Extraer el postId desde el HTML o vía API
    let postId = this.extractPostId(html);

    if (!postId) {
      const slugMatch = cleanUrl.match(/\/(?:peliculas|series|novelas|animes)\/([^/]+)/);
      if (slugMatch) {
        const slug = slugMatch[1];
        const postType = cleanUrl.includes("/series/") ? "tvshows" : "movies";
        const apiSingleUrl = `https://lamovie.org/wp-api/v1/single/${postType}?slug=${encodeURIComponent(slug)}&postType=${postType}`;
        const apiRes = await this.fetchHtml(apiSingleUrl);
        if (apiRes) {
          try {
            const parsed = JSON.parse(apiRes);
            const idVal = parsed?.id || parsed?.data?.id || parsed?.data?._id || parsed?._id;
            if (idVal) postId = String(idVal);
          } catch {}
        }
      }
    }

    const embedUrls: string[] = [];

    // 2. Si obtuvimos postId, consultar la API interna de reproductores: wp-api/v1/player?postId=...
    if (postId) {
      const playerApiUrl = `https://lamovie.org/wp-api/v1/player?postId=${postId}&demo=0`;
      const playerRes = await this.fetchHtml(playerApiUrl, 7500, { Referer: cleanUrl });

      if (playerRes) {
        try {
          const parsed = JSON.parse(playerRes);
          const embeds = parsed?.data?.embeds || parsed?.embeds || [];
          if (Array.isArray(embeds)) {
            embeds.forEach((e: any) => {
              if (e?.url && typeof e.url === "string") {
                embedUrls.push(e.url);
              }
            });
          }
        } catch {}
      }
    }

    // 3. Fallback: extraer iframes del DOM
    if (embedUrls.length === 0) {
      $("iframe").each((_, el) => {
        const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-player");
        if (src && !embedUrls.includes(src) && !/(ads|adserver|popunder|banner)/i.test(src)) {
          embedUrls.push(this.resolveRelativeUrl(src, cleanUrl));
        }
      });
    }

    // 4. Resolver cada iframe embed para obtener la URL directa (.m3u8 / .mp4)
    const resolvedStreams: string[] = [];
    for (const embedUrl of embedUrls) {
      if (embedUrl.includes(".m3u8") || embedUrl.endsWith(".mp4")) {
        if (!resolvedStreams.includes(embedUrl)) resolvedStreams.push(embedUrl);
      } else {
        const iframeStreams = await this.resolveIframeStream(embedUrl, cleanUrl);
        if (iframeStreams.length > 0) {
          iframeStreams.forEach((st) => {
            if (!resolvedStreams.includes(st)) resolvedStreams.push(st);
          });
        } else {
          // Intentar con EmbedResolvers estándar
          const resolved = await EmbedResolvers.resolve(embedUrl);
          if (resolved && !resolvedStreams.includes(resolved)) {
            resolvedStreams.push(resolved);
          }
        }
      }
      if (!resolvedStreams.includes(embedUrl)) {
        resolvedStreams.push(embedUrl);
      }
    }

    const validStreams = await MediaValidator.validateUrls(resolvedStreams);
    const finalStreams = validStreams.length > 0 ? validStreams : (resolvedStreams.length > 0 ? resolvedStreams : [cleanUrl]);

    return {
      stream_url: finalStreams[0],
      all_available_streams: finalStreams,
      title: title || undefined,
    };
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
    const isCatalog =
      explicitType === "catalog" ||
      urlObj.pathname.startsWith("/peliculas") ||
      urlObj.pathname.startsWith("/series") ||
      urlObj.pathname.startsWith("/animes") ||
      urlObj.pathname === "/" ||
      urlObj.search.includes("page=") ||
      classifiedType === "catalog" ||
      (catalogItems.length >= 3 && explicitType !== "detail");

    if (isCatalog) {
      // Si la página HTML es una SPA con 0 tarjetas en el HTML estático, consultar el sitemap correspondiente
      if (catalogItems.length === 0) {
        const pageParam = urlObj.searchParams.get("page") || "1";
        const isSeries = urlObj.pathname.includes("/series");
        const isAnime = urlObj.pathname.includes("/animes");

        let sitemapUrl = `https://lamovie.org/wp-sitemap-posts-movies-${pageParam}.xml`;
        if (isSeries) {
          sitemapUrl = `https://lamovie.org/wp-sitemap-posts-tvshows-${pageParam}.xml`;
        } else if (isAnime) {
          sitemapUrl = `https://lamovie.org/wp-sitemap-posts-animes-${pageParam}.xml`;
        }

        try {
          let sitemapXml = await this.fetchHtml(sitemapUrl, 6000);
          if (!sitemapXml && !isSeries && !isAnime) {
            sitemapXml = await this.fetchHtml("https://lamovie.org/movies-sitemap.xml", 6000);
          }

          if (sitemapXml) {
            const xml$ = cheerio.load(sitemapXml, { xmlMode: true });
            xml$("url, sitemap").each((_, el) => {
              const loc = xml$(el).find("loc").text().trim();
              if (loc && (loc.includes("/peliculas/") || loc.includes("/series/") || loc.includes("/animes/"))) {
                const parts = loc.split("/").filter(Boolean);
                const slug = parts[parts.length - 1] || "";
                if (slug && slug !== "peliculas" && slug !== "series" && slug !== "animes") {
                  const rawTitle = slug.replace(/-/g, " ").replace(/\b\d{4}\b$/, "").trim();
                  const cleanTitle = cleanQueryTitle(rawTitle);
                  catalogItems.push({
                    title: cleanTitle,
                    url: loc,
                    kind: isAnime ? "anime" : (isSeries ? "series" : "movie"),
                  });
                }
              }
            });
          }
        } catch {}
      }

      return {
        page_type: "catalog",
        content_type: "mixed",
        title: $("title").text().trim() || "LaMovie Catálogo",
        description: "Catálogo completo de películas, series y animes de LaMovie.",
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

    let rating = 8.0;
    const imdbScore = $(".imdb-score").first().text().trim();
    if (imdbScore) rating = parseFloat(imdbScore);

    const yearStr = $(".rates .year").first().text().trim();
    const year = yearStr ? parseInt(yearStr, 10) : 2024;

    let contentType = "movie";
    if (urlObj.pathname.includes("/series/")) {
      contentType = "series";
    } else if (urlObj.pathname.includes("/animes/")) {
      contentType = "anime";
    }

    // Extraer streams en tiempo real
    const streamResult = await this.extractStream(cleanUrl).catch(() => ({
      stream_url: cleanUrl,
      all_available_streams: [cleanUrl],
      title: title,
    }));

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
      detected_streams: streamResult.all_available_streams,
      episodes: streamResult.all_available_streams.length > 0 ? streamResult.all_available_streams.map((url, idx) => ({
        number: idx + 1,
        title: `Servidor ${idx + 1}`,
        url
      })) : [{ number: 1, title: "Video", url: cleanUrl }],
      catalog_items: [],
    };
  }

  private extractPostId(html: string): string | null {
    const match = 
      html.match(/shortlink['"][^>]*\?p=(\d+)/i) ||
      html.match(/postId\s*[:=]\s*["']?(\d+)["']?/i) ||
      html.match(/_id\s*[:=]\s*["']?(\d+)["']?/i) ||
      html.match(/postid-(\d+)/i) ||
      html.match(/post-(\d+)/i) ||
      html.match(/data-id=["'](\d+)["']/i) ||
      html.match(/"_id"\s*:\s*["']?(\d+)["']?/i) ||
      html.match(/"id"\s*:\s*["']?(\d+)["']?/i);

    return match ? match[1] : null;
  }
}
