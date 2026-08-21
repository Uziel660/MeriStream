import * as cheerio from "cheerio";
import { UniversalAnalysisResult, ContentKind, ExtractedEpisode, ExtractedCatalogItem } from "../types";
import { EmbedResolvers } from "../resolvers";
import { MediaValidator } from "../validator";

export const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
};

export abstract class BaseScraperAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly supportedDomains: string[];

  /**
   * Determina si este adaptador puede procesar la URL proporcionada.
   */
  abstract canHandle(url: string): boolean;

  /**
   * Ejecuta el análisis completo de la URL dada.
   * @param input URL de entrada o término de búsqueda.
   * @param explicitType Tipo de extracción solicitado opcionalmente desde el frontend.
   */
  abstract analyze(input: string, explicitType?: "auto" | "catalog" | "detail" | "stream"): Promise<UniversalAnalysisResult>;

  /**
   * Extrae streams de video en tiempo real (Just-In-Time) de una página específica de episodio/película.
   */
  public async extractStream(targetUrl: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const cleanUrl = targetUrl.trim();
    try {
      const html = await this.fetchHtml(cleanUrl, 6000);
      if (!html) {
        return { stream_url: cleanUrl, all_available_streams: [cleanUrl] };
      }

      const $ = cheerio.load(html);
      const rawStreams = this.extractEmbedsAndStreamsFromHtml($, html, cleanUrl);

      const resolvedStreams: string[] = [];
      for (const stream of rawStreams) {
        const resolved = await EmbedResolvers.resolve(stream);
        resolvedStreams.push(resolved || stream);
      }

      const validStreams = await MediaValidator.validateUrls(resolvedStreams);
      const finalStreams = validStreams.length > 0 ? validStreams : (resolvedStreams.length > 0 ? resolvedStreams : [cleanUrl]);

      return {
        stream_url: finalStreams[0],
        all_available_streams: finalStreams,
        title: $("title").text().trim() || undefined,
      };
    } catch {
      return {
        stream_url: cleanUrl,
        all_available_streams: [cleanUrl],
      };
    }
  }

  /**
   * Utilidad común para realizar solicitudes HTTP con timeout y abort signal seguro.
   */
  protected async fetchHtml(url: string, timeoutMs: number = 7500): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: COMMON_HEADERS,
      });
      clearTimeout(timer);

      if (!response.ok) return null;
      return await response.text();
    } catch {
      return null;
    }
  }

  /**
   * Extrae URLs de reproducción, iframes y servidores de un HTML.
   */
  protected extractEmbedsAndStreamsFromHtml($: cheerio.CheerioAPI, html: string, baseUrl: string): string[] {
    const streams: string[] = [];

    // 1. <video> & <source> tags
    $("video source, video").each((_, el) => {
      const src = $(el).attr("src");
      if (src && !streams.includes(src)) {
        streams.push(this.resolveRelativeUrl(src, baseUrl));
      }
    });

    // 2. <iframe> tags (embed players)
    $("iframe").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-player");
      if (src && !streams.includes(src)) {
        streams.push(this.resolveRelativeUrl(src, baseUrl));
      }
    });

    // 3. Data attributes
    $("[data-video], [data-server], [data-url], [data-src], [data-player], [data-embed]").each((_, el) => {
      const val = $(el).attr("data-video") || $(el).attr("data-url") || $(el).attr("data-src") || $(el).attr("data-player") || $(el).attr("data-embed") || "";
      if (val) {
        if (val.startsWith("http://") || val.startsWith("https://") || val.startsWith("//")) {
          const resolved = this.resolveRelativeUrl(val, baseUrl);
          if (!streams.includes(resolved)) streams.push(resolved);
        } else if (this.isBase64(val)) {
          try {
            const decoded = Buffer.from(val, "base64").toString("utf-8");
            if (decoded.startsWith("http") && !streams.includes(decoded)) {
              streams.push(decoded);
            }
          } catch {}
        }
      }
    });

    // 4. Host regex
    const hostRegex = /https?:\/\/(?:www\.)?(?:mega\.nz|streamtape\.com|mp4upload\.com|yourupload\.com|streamwish\.[a-z]+|filemoon\.[a-z]+|voe\.[a-z]+|dood\.[a-z]+|ok\.ru|vidstream\.[a-z]+|fembed\.[a-z]+|mixdrop\.[a-z]+|uqload\.[a-z]+|upstream\.[a-z]+|embedsito\.[a-z]+|streamlare\.[a-z]+|fastre\.[a-z]+)\/[^\s"'<>]+/gi;
    const hostMatches = html.match(hostRegex);
    if (hostMatches) {
      hostMatches.forEach((m) => {
        const clean = m.replace(/\\/g, "");
        if (!streams.includes(clean)) streams.push(clean);
      });
    }

    // 5. Media file regex
    const mediaFileRegex = /https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4|webm)[^\s"'<>]*/gi;
    const mediaMatches = html.match(mediaFileRegex);
    if (mediaMatches) {
      mediaMatches.forEach((m) => {
        const clean = m.replace(/\\/g, "");
        if (!streams.includes(clean)) streams.push(clean);
      });
    }

    return streams;
  }

  protected resolveRelativeUrl(url: string, base: string): string {
    if (url.startsWith("//")) return `https:${url}`;
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    try {
      return new URL(url, base).toString();
    } catch {
      return url;
    }
  }

  protected isBase64(str: string): boolean {
    if (str.length < 8 || str.length % 4 !== 0) return false;
    return /^[A-Za-z0-9+/]+={0,2}$/.test(str);
  }
}
