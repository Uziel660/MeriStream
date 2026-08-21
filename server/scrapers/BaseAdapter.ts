import * as cheerio from "cheerio";
import { UniversalAnalysisResult, ContentKind, ExtractedEpisode, ExtractedCatalogItem } from "../types";
import { EmbedResolvers } from "../resolvers";
import { MediaValidator } from "../validator";

export const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
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
   * Extrae URLs de reproducción, iframes, variables JavaScript y servidores de un HTML.
   */
  protected extractEmbedsAndStreamsFromHtml($: cheerio.CheerioAPI, html: string, baseUrl: string): string[] {
    const streams: string[] = [];

    // 1. AnimeFLV / Streaming JavaScript object `var videos = { "SUB": [ ... ] }`
    const videoObjectMatch = html.match(/var\s+videos\s*=\s*(\{.+?\});/s) || html.match(/videos\s*=\s*(\{.+?\});/s);
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

    // 2. <video> & <source> tags
    $("video source, video").each((_, el) => {
      const src = $(el).attr("src");
      if (src && !streams.includes(src)) {
        streams.push(this.resolveRelativeUrl(src, baseUrl));
      }
    });

    // 3. <iframe> tags (embed players)
    $("iframe").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-player") || $(el).attr("data-url");
      if (src && !streams.includes(src)) {
        streams.push(this.resolveRelativeUrl(src, baseUrl));
      }
    });

    // 4. Data attributes on buttons, tabs and players
    $("[data-video], [data-server], [data-url], [data-src], [data-player], [data-embed], [data-code]").each((_, el) => {
      const val =
        $(el).attr("data-video") ||
        $(el).attr("data-url") ||
        $(el).attr("data-src") ||
        $(el).attr("data-player") ||
        $(el).attr("data-embed") ||
        $(el).attr("data-code") ||
        "";
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

    // 5. Scan regex for known streaming hosts in scripts
    const hostRegex = /https?:\/\/(?:www\.)?(?:mega\.nz|streamtape\.com|mp4upload\.com|yourupload\.com|streamwish\.[a-z0-9]+|filemoon\.[a-z0-9]+|voe\.[a-z0-9]+|dood\.[a-z0-9]+|doodstream\.[a-z0-9]+|ok\.ru|vidstream\.[a-z0-9]+|fembed\.[a-z0-9]+|mixdrop\.[a-z0-9]+|uqload\.[a-z0-9]+|upstream\.[a-z0-9]+|embedsito\.[a-z0-9]+|streamlare\.[a-z0-9]+|fastre\.[a-z0-9]+|vidmoly\.[a-z0-9]+|luluvdo\.[a-z0-9]+|streamhide\.[a-z0-9]+|gamovideo\.[a-z0-9]+|netu\.[a-z0-9]+|waaw\.[a-z0-9]+|streamdav\.[a-z0-9]+|streamhub\.[a-z0-9]+|zilla-networks\.com)\/[^\s"'<>]+/gi;
    const hostMatches = html.match(hostRegex);
    if (hostMatches) {
      hostMatches.forEach((m) => {
        const clean = m.replace(/\\/g, "");
        if (!streams.includes(clean)) streams.push(clean);
      });
    }

    // 6. Scan for direct .m3u8 or .mp4 files inside scripts
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
