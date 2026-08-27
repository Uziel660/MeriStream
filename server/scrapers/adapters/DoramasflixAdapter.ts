import * as cheerio from "cheerio";
import { BaseScraperAdapter, COMMON_HEADERS } from "../BaseAdapter";
import { UniversalAnalysisResult, ContentKind, ExtractedEpisode, ExtractedCatalogItem } from "../../types";
import { EmbedResolvers } from "../../resolvers";
import { MediaValidator } from "../../validator";

const BASE_URL = "https://doramasflix.io";
const NEXT_ACTION_ID = "40c3671ad750012fd1bcbcb050c7894f427d37a8b1";

export class DoramasflixAdapter extends BaseScraperAdapter {
  readonly id = "doramasflix";
  readonly name = "Doramasflix (Doramas, Películas, Variedades)";
  readonly supportedDomains = ["doramasflix.io", "doramasflix.co", "doramasflix.net", "doramasflix.in", "doramasflix.com"];

  canHandle(url: string): boolean {
    const lower = url.toLowerCase();
    return this.supportedDomains.some((domain) => lower.includes(domain));
  }

  public async analyze(input: string, explicitType?: "auto" | "catalog" | "detail" | "stream"): Promise<UniversalAnalysisResult> {
    const url = input.trim();

    // 1. Si es un episodio o se pide stream directamente
    if (explicitType === "stream" || url.includes("/capitulos/")) {
      const streamRes = await this.extractStream(url);
      return {
        page_type: "direct_stream",
        content_type: "series",
        title: streamRes.title || "Doramasflix Stream",
        description: "",
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: new Date().getFullYear(),
        status: "ongoing",
        genres: ["Dorama"],
        detected_streams: streamRes.all_available_streams,
        episodes: [],
        catalog_items: [],
      };
    }

    // 2. Si es catálogo (/peliculas, /variedades, /doramas)
    if (explicitType === "catalog" || url.endsWith("/peliculas") || url.endsWith("/variedades") || url.endsWith("/doramas")) {
      const items = await this.extractCatalog(url);
      const isMovie = url.includes("/peliculas");
      return {
        page_type: "catalog",
        content_type: isMovie ? "movie" : "series",
        title: `Catálogo ${isMovie ? "Películas" : "Doramas"} - Doramasflix`,
        description: "Catálogo extraído de Doramasflix",
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: new Date().getFullYear(),
        status: "ongoing",
        genres: ["Dorama"],
        episodes: [],
        catalog_items: items,
      };
    }

    // 3. Detalle de Dorama / Película
    return this.extractDetail(url);
  }

  /**
   * Extrae el catálogo de /doramas, /peliculas o /variedades
   */
  private async extractCatalog(url: string): Promise<ExtractedCatalogItem[]> {
    const html = await this.fetchHtml(url);
    if (!html) return [];

    const $ = cheerio.load(html);
    const items: ExtractedCatalogItem[] = [];
    const seen = new Set<string>();

    $("a[href*='/doramas/'], a[href*='/peliculas/'], a[href*='/variedades/']").each((_, el) => {
      const href = $(el).attr("href");
      if (!href || href === "/doramas" || href === "/peliculas" || href === "/variedades" || seen.has(href)) return;

      const fullUrl = this.resolveRelativeUrl(href, BASE_URL);
      const $parent = $(el).closest("div, article");
      const title = $parent.find("h2, h3, .title, .name").first().text().trim() || $(el).attr("title")?.trim() || "";
      const img = $parent.find("img").attr("src") || $parent.find("img").attr("data-src") || "";

      let kind: ContentKind = "series";
      if (url.includes("/peliculas") || href.includes("/peliculas/")) {
        kind = "movie";
      }

      if (title && fullUrl) {
        seen.add(href);
        items.push({
          title,
          url: fullUrl,
          image_url: img ? this.resolveRelativeUrl(img, BASE_URL) : null,
          kind,
        });
      }
    });

    return items;
  }

  /**
   * Extrae metadatos y lista de episodios desde la página de detalle
   */
  private async extractDetail(url: string): Promise<UniversalAnalysisResult> {
    const html = await this.fetchHtml(url);
    if (!html) {
      return {
        page_type: "detail",
        content_type: "series",
        title: "",
        description: "",
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: 0,
        status: "",
        genres: [],
        episodes: [],
        catalog_items: [],
      };
    }

    const $ = cheerio.load(html);
    const title = $("h1").first().text().trim() || $("meta[property='og:title']").attr("content") || $("title").text().trim();
    const description = $("meta[property='og:description']").attr("content") || $(".synopsis, .overview, p").first().text().trim();
    const poster_url = $("meta[property='og:image']").attr("content") || $(".poster img, img[src*='tmdb']").attr("src") || null;

    const episodes: ExtractedEpisode[] = [];
    const seenEp = new Set<string>();

    $("a[href*='/capitulos/']").each((idx, el) => {
      const href = $(el).attr("href");
      if (!href || seenEp.has(href)) return;
      seenEp.add(href);

      const epTitle = $(el).text().trim() || `Capítulo ${idx + 1}`;
      episodes.push({
        number: idx + 1,
        title: epTitle,
        url: this.resolveRelativeUrl(href, BASE_URL),
      });
    });

    const isMovie = url.includes("/pelicula/") || url.includes("/peliculas/") || episodes.length === 0;

    return {
      page_type: "detail",
      content_type: isMovie ? "movie" : "series",
      title,
      description,
      poster_url: poster_url ? this.resolveRelativeUrl(poster_url, BASE_URL) : null,
      banner_url: null,
      rating: 0,
      year: new Date().getFullYear(),
      status: "ongoing",
      genres: ["Dorama"],
      episodes,
      catalog_items: [],
    };
  }

  /**
   * Extrae y desencripta los servidores/embeds reales de un episodio mediante Next-Action + JWT decoding
   */
  public async extractStream(targetUrl: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const cleanUrl = targetUrl.trim();
    try {
      const html = await this.fetchHtml(cleanUrl, 8000);
      if (!html) {
        return { stream_url: cleanUrl, all_available_streams: [cleanUrl] };
      }

      const $ = cheerio.load(html);
      const pageTitle = $("title").text().trim() || undefined;

      // Extraer episode_id del HTML
      const episodeMatch = html.match(/episode\\?"\s*:\s*\{[^}]*?\\?"_id\\?"\s*:\s*\\?"([a-f0-9]{24})\\?"/i) ||
                           html.match(/\\?"_id\\?"\s*:\s*\\?"(6a[a-f0-9]{22})\\?"/i);

      if (!episodeMatch) {
        return { stream_url: cleanUrl, all_available_streams: [cleanUrl], title: pageTitle };
      }

      const episodeId = episodeMatch[1];

      // Ejecutar Next-Action POST
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);

      const actionRes = await fetch(cleanUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          ...COMMON_HEADERS,
          "Next-Action": NEXT_ACTION_ID,
          "Content-Type": "text/plain;charset=UTF-8",
          "Accept": "text/x-component"
        },
        body: JSON.stringify([{ episode_id: episodeId }])
      });
      clearTimeout(timer);

      if (!actionRes.ok) {
        return { stream_url: cleanUrl, all_available_streams: [cleanUrl], title: pageTitle };
      }

      const actionText = await actionRes.text();
      const line1 = actionText.split("\n").find((l) => l.startsWith("1:"));
      if (!line1) {
        return { stream_url: cleanUrl, all_available_streams: [cleanUrl], title: pageTitle };
      }

      const rawServers = JSON.parse(line1.slice(2));
      const embedUrls: string[] = [];

      for (const s of rawServers) {
        if (!s.link) continue;
        const decoded = this.decodeEmbedShortenerLink(s.link);
        if (decoded) {
          embedUrls.push(decoded);
        }
      }

      // Resolver embeds a stream directo / iframe limpio
      const resolvedStreams: string[] = [];
      for (const embedUrl of embedUrls) {
        const resolved = await EmbedResolvers.resolve(embedUrl);
        resolvedStreams.push(resolved || embedUrl);
      }

      const validStreams = await MediaValidator.validateUrls(resolvedStreams);
      const finalStreams = validStreams.length > 0 ? validStreams : (resolvedStreams.length > 0 ? resolvedStreams : [cleanUrl]);

      return {
        stream_url: finalStreams[0],
        all_available_streams: finalStreams,
        title: pageTitle,
      };
    } catch {
      return {
        stream_url: cleanUrl,
        all_available_streams: [cleanUrl],
      };
    }
  }

  /**
   * Desencripta el enlace `https://embedshortener.co/e/<jwt>`
   * 1. Extrae el payload JWT (Base64URL)
   * 2. Parsea `{ "link": "<base64_embed_url>" }`
   * 3. Retorna la URL del reproductor desencriptada
   */
  private decodeEmbedShortenerLink(embedShortenerUrl: string): string | null {
    try {
      const jwt = embedShortenerUrl.split("/e/")[1];
      if (!jwt) return null;
      const parts = jwt.split(".");
      if (parts.length < 2) return null;

      let payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (payloadB64.length % 4) payloadB64 += "=";

      const payloadJson = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf-8"));
      if (!payloadJson.link) return null;

      let linkB64 = payloadJson.link.replace(/-/g, "+").replace(/_/g, "/");
      while (linkB64.length % 4) linkB64 += "=";

      return Buffer.from(linkB64, "base64").toString("utf-8");
    } catch {
      return null;
    }
  }

  private resolveRelativeUrl(relative: string, base: string): string {
    try {
      return new URL(relative, base).href;
    } catch {
      return relative;
    }
  }
}
