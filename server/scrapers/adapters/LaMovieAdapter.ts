import * as cheerio from "cheerio";
import { BaseScraperAdapter, COMMON_HEADERS } from "../BaseAdapter";
import { UniversalAnalysisResult, ContentKind, ExtractedEpisode, ExtractedCatalogItem } from "../../types";
import { unpackGeneric, extractMediaUrlsFromCode } from "../utils/jsUnpacker";
import { EmbedResolvers } from "../../resolvers";

/**
 * Adaptador para lamovie.org - Extrae catálogo de sitemaps XML, detalles de páginas estáticas,
 * y streams de la API interna wp-api/v1/player
 */
export class LaMovieAdapter extends BaseScraperAdapter {
  readonly id = "lamovie";
  readonly name = "LaMovie (Películas, Series, Animes)";
  readonly supportedDomains = ["lamovie.org", "lamovie.to", "lamovie.ws"];

  canHandle(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.includes("lamovie.");
  }

  /**
   * Extrae el catálogo desde los sitemaps XML oficiales
   * Ejemplo: https://lamovie.org/wp-sitemap-posts-movies-1.xml
   */
  private async extractCatalogFromSitemap(contentType: ContentKind, page: number = 1): Promise<ExtractedCatalogItem[]> {
    const sitemapMap: Record<ContentKind, string> = {
      movie: "movies",
      series: "tvshows",
      anime: "animes",
      documentary: "movies",
      open_archive: "movies",
    };

    const sitemapType = sitemapMap[contentType] || "movies";
    const sitemapUrl = `https://lamovie.org/wp-sitemap-posts-${sitemapType}-${page}.xml`;

    const xml = await this.fetchHtml(sitemapUrl, 10000);
    if (!xml) return [];

    const $ = cheerio.load(xml, { xmlMode: true });
    const items: ExtractedCatalogItem[] = [];

    $("loc").each((_, el) => {
      const url = $(el).text().trim();
      if (!url || (!url.includes("/peliculas/") && !url.includes("/series/") && !url.includes("/animes/"))) {
        return;
      }

      // Extraer slug de la URL
      const slugMatch = url.match(/\/(?:peliculas|series|animes)\/([^/]+)\/?$/);
      if (!slugMatch) return;

      const slug = slugMatch[1];
      if (["peliculas", "series", "animes"].includes(slug)) return;

      // Limpiar título: quitar guiones y año final
      const cleanTitle = slug
        .replace(/-\d{4}$/, "")
        .replace(/-/g, " ")
        .replace(/\b\w/g, (l) => l.toUpperCase())
        .trim();

      items.push({
        title: cleanTitle,
        url,
        kind: contentType,
      });
    });

    return items;
  }

  /**
   * Extrae el Post ID de WordPress desde el HTML
   * Busca en: <link rel="shortlink" href="https://lamovie.org/?p=ID" />
   */
  private extractPostId(html: string): string | null {
    const shortlinkMatch = html.match(/shortlink[^>]*\?p=(\d+)/i);
    if (shortlinkMatch) return shortlinkMatch[1];

    // Fallback: buscar en JSON-LD
    const jsonLdMatch = html.match(/"@id"\s*:\s*"[^"]*\/(\d+)"/);
    if (jsonLdMatch) return jsonLdMatch[1];

    // Fallback: buscar en data attributes
    const dataIdMatch = html.match(/data-id[="'](\d+)["']/i);
    if (dataIdMatch) return dataIdMatch[1];

    return null;
  }

  /**
   * Extrae episodios de una serie desde el HTML
   * Busca enlaces a /episodio/ o /temporada/
   */
  private extractEpisodes(html: string, baseUrl: string): ExtractedEpisode[] {
    const $ = cheerio.load(html);
    const episodes: ExtractedEpisode[] = [];

    // Buscar enlaces de episodios
    const episodeLinks = $("a[href*='/episodio/'], a[href*='/temporada/']");
    episodeLinks.each((i, el) => {
      const href = $(el).attr("href");
      const title = $(el).text().trim();
      if (!href) return;

      const fullUrl = this.resolveRelativeUrl(href, baseUrl);
      const numberMatch = title.match(/(\d+)/) || href.match(/episodio-(\d+)/);
      const number = numberMatch ? parseInt(numberMatch[1], 10) : i + 1;

      episodes.push({
        number,
        title: title || `Episodio ${number}`,
        url: fullUrl,
        server_name: "LaMovie",
      });
    });

    return episodes;
  }

  /**
   * Extrae metadatos de una página de detalle
   */
  private extractMetadata(html: string, url: string): {
    title: string;
    original_title?: string;
    description: string;
    poster_url?: string;
    banner_url?: string;
    rating: number;
    year: number;
    genres: string[];
    duration?: string;
    content_type: ContentKind;
  } {
    const $ = cheerio.load(html);

    // Título
    const ogTitle = $('meta[property="og:title"]').attr("content") || "";
    const h1Title = $("h1").first().text().trim();
    const title = ogTitle || h1Title || "Contenido LaMovie";

    // Título original (si está en el título)
    const originalTitleMatch = title.match(/(.+)\s*\((\d{4})\)\s*\|/);
    const original_title = originalTitleMatch ? originalTitleMatch[1].trim() : undefined;

    // Descripción
    const ogDesc = $('meta[property="og:description"]').attr("content") ||
      $('meta[name="description"]').attr("content") ||
      $(".overview, .sinopsis, .description").first().text().trim() ||
      "";

    // Poster
    const ogImage = $('meta[property="og:image"]').attr("content");
    const posterUrl = ogImage ? this.resolveRelativeUrl(ogImage, url) : undefined;

    // Rating (IMDb)
    const ratingMatch = html.match(/IMDb[\s:]*([\d.]+)/i) ||
      html.match(/rating[\s:]*([\d.]+)/i);
    const rating = ratingMatch ? parseFloat(ratingMatch[1]) : 7.0;

    // Año
    const yearMatch = html.match(/Año[\s:]*(\d{4})/i) ||
      html.match(/(\d{4})\s*\|/i) ||
      html.match(/release_date[\s:]*["'](\d{4})/i);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();

    // Géneros
    const genres: string[] = [];
    $("a[href*='/genero/'], .genres a, .meta-genres a").each((_, el) => {
      const genre = $(el).text().trim();
      if (genre && !genres.includes(genre)) {
        genres.push(genre);
      }
    });

    // Duración
    const durationMatch = html.match(/Duración[\s:]*([\d]+\s*min)/i);
    const duration = durationMatch ? durationMatch[1] : undefined;

    // Tipo de contenido
    const content_type = url.includes("/series/") ? "series" :
      url.includes("/animes/") ? "anime" : "movie";

    return {
      title,
      original_title,
      description: ogDesc,
      poster_url: posterUrl,
      banner_url: posterUrl,
      rating,
      year,
      genres,
      duration,
      content_type,
    };
  }

  /**
   * Resuelve un iframe de reproductor desofuscando el JS interno
   */
  public async resolveIframeStream(iframeUrl: string, referer: string = "https://lamovie.org/"): Promise<string[]> {
    try {
      const html = await this.fetchHtml(iframeUrl, 7500, {
        Referer: referer,
        "User-Agent": COMMON_HEADERS["User-Agent"],
      });

      if (!html) return [];

      // Desofuscar todo el HTML
      const unpacked = unpackGeneric(html);
      const urls = extractMediaUrlsFromCode(unpacked);

      // Filtrar URLs válidas
      return urls.filter(url =>
        url.includes(".m3u8") || url.includes(".mp4") || url.includes(".webm")
      );
    } catch {
      return [];
    }
  }

  /**
   * Extrae streams de video usando la API interna de LaMovie
   */
  public async extractStream(targetUrl: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const cleanUrl = targetUrl.trim();
    const html = await this.fetchHtml(cleanUrl, 10000);

    if (!html) {
      throw new Error("No se pudo obtener el HTML de la página");
    }

    // Extraer Post ID
    const postId = this.extractPostId(html);
    if (!postId) {
      throw new Error("No se encontró el Post ID en la página");
    }

    // Consultar API de reproductor
    const playerApiUrl = `https://lamovie.org/wp-api/v1/player?postId=${postId}&demo=0`;
    const playerRes = await this.fetchHtml(playerApiUrl, 7500, {
      Referer: cleanUrl,
      "User-Agent": COMMON_HEADERS["User-Agent"],
    });

    if (!playerRes) {
      throw new Error("No se pudo obtener datos del reproductor");
    }

    let embedUrls: string[] = [];
    try {
      const playerData = JSON.parse(playerRes);
      const embeds = playerData?.data?.embeds || playerData?.embeds || [];
      embedUrls = embeds.map((e: any) => e.url).filter(Boolean);
    } catch {
      // Fallback: extraer iframes del HTML
      const $ = cheerio.load(html);
      $("iframe").each((_, el) => {
        const src = $(el).attr("src");
        if (src && !/(ads|adserver|popunder|banner)/i.test(src)) {
          embedUrls.push(this.resolveRelativeUrl(src, cleanUrl));
        }
      });
    }

    // Resolver cada iframe para obtener streams directos
    const resolvedStreams: string[] = [];
    for (const embedUrl of embedUrls) {
      if (embedUrl.includes(".m3u8") || embedUrl.includes(".mp4")) {
        if (!resolvedStreams.includes(embedUrl)) {
          resolvedStreams.push(embedUrl);
        }
      } else {
        const iframeStreams = await this.resolveIframeStream(embedUrl, cleanUrl);
        if (iframeStreams.length > 0) {
          iframeStreams.forEach((st) => {
            if ((st.includes(".m3u8") || st.endsWith(".mp4")) && !resolvedStreams.includes(st)) {
              resolvedStreams.push(st);
            }
          });
        } else {
          // Intentar con EmbedResolvers estándar
          const resolved = await EmbedResolvers.resolve(embedUrl);
          if (resolved && (resolved.includes(".m3u8") || resolved.endsWith(".mp4")) && !resolvedStreams.includes(resolved)) {
            resolvedStreams.push(resolved);
          }
        }
      }
    }

    // Extraer título
    const $ = cheerio.load(html);
    const title = $("h1").first().text().trim() || $('meta[property="og:title"]').attr("content") || "";

    // Si no se resolvieron streams, devolver los embed URLs como fallback
    const finalStreams = resolvedStreams.length > 0 ? resolvedStreams : embedUrls;

    return {
      stream_url: finalStreams[0] || cleanUrl,
      all_available_streams: finalStreams.length > 0 ? finalStreams : [cleanUrl],
      title: title || undefined,
    };
  }

  /**
   * Analiza una URL de LaMovie (catálogo, detalle o stream)
   */
  public async analyze(input: string, explicitType?: "auto" | "catalog" | "detail" | "stream"): Promise<UniversalAnalysisResult> {
    const cleanUrl = input.trim();
    const urlObj = new URL(cleanUrl);
    const path = urlObj.pathname.toLowerCase().replace(/\/$/, "");

    // Determinar tipo de contenido
    const isSeries = path.includes("/series") || path.includes("/tvshows");
    const isAnime = path.includes("/animes") || path.includes("/anime");
    const contentType: ContentKind = isSeries ? "series" : isAnime ? "anime" : "movie";

    // Extraer número de página si existe (ej. ?page=2 o /page/2)
    const pageParam = urlObj.searchParams.get("page") || cleanUrl.match(/\/page\/(\d+)/)?.[1] || "1";
    const pageNum = Math.max(1, parseInt(pageParam, 10) || 1);

    // 1. Si es una URL de catálogo (ej: /peliculas, /series, /animes, /, ?page=...) o explicitType === "catalog"
    const isCatalog =
      explicitType === "catalog" ||
      path === "" ||
      path === "/" ||
      path === "/peliculas" ||
      path === "/series" ||
      path === "/animes" ||
      path.match(/^\/(?:peliculas|series|animes)\/page\/\d+/i) !== null ||
      urlObj.searchParams.has("page");

    if (isCatalog) {
      const catalogItems = await this.extractCatalogFromSitemap(contentType, pageNum);
      const titleType = contentType === "movie" ? "Películas" : contentType === "series" ? "Series" : "Animes";
      return {
        page_type: "catalog",
        content_type: contentType,
        title: `Catálogo de ${titleType} - LaMovie (Pág ${pageNum})`,
        description: `Catálogo de ${titleType} en LaMovie (${catalogItems.length} títulos disponibles)`,
        poster_url: null,
        banner_url: null,
        rating: 8.0,
        year: new Date().getFullYear(),
        status: "Publicado",
        genres: [titleType, "Directorio"],
        source_domain: "lamovie.org",
        episodes: [],
        catalog_items: catalogItems,
      };
    }

    // 2. Si es una URL de detalle (página individual)
    const html = await this.fetchHtml(cleanUrl, 10000);
    if (!html) {
      return {
        page_type: "detail",
        content_type: contentType as ContentKind,
        title: "Contenido LaMovie",
        description: "No se pudo cargar la página",
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: new Date().getFullYear(),
        status: "Desconocido",
        genres: [],
        source_domain: "lamovie.org",
        episodes: [],
        catalog_items: [],
      };
    }

    // Extraer metadatos
    const metadata = this.extractMetadata(html, cleanUrl);

    // Extraer episodios (si es serie/anime)
    const episodes = contentType === "series" || contentType === "anime" ?
      this.extractEpisodes(html, cleanUrl) : [];

    // Extraer streams si se solicita
    let detectedStreams: string[] = [];
    if (explicitType === "stream" || explicitType === "auto") {
      try {
        const streamResult = await this.extractStream(cleanUrl);
        detectedStreams = streamResult.all_available_streams;
      } catch {}
    }

    return {
      page_type: "detail",
      content_type: metadata.content_type,
      title: metadata.title,
      original_title: metadata.original_title,
      description: metadata.description,
      poster_url: metadata.poster_url || null,
      banner_url: metadata.banner_url || null,
      rating: metadata.rating,
      year: metadata.year,
      status: "Publicado",
      genres: metadata.genres,
      duration: metadata.duration || null,
      source_domain: "lamovie.org",
      detected_streams: detectedStreams.length > 0 ? detectedStreams : undefined,
      episodes,
      catalog_items: [],
      raw_metadata: {
        og: {
          title: metadata.title,
          description: metadata.description,
          image: metadata.poster_url || "",
        },
      },
    };
  }
}
