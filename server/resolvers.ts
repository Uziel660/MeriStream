// server/resolvers.ts
import { unpackDeanEdwards, unpackGeneric, extractMediaUrlsFromCode } from "./scrapers/utils/jsUnpacker";

export class EmbedResolvers {
  private constructor() {}
  private static readonly DEFAULT_TIMEOUT = 8000;
  private static readonly DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };

  /**
   * Resuelve la URL real directa (.m3u8 / .mp4) a partir de una URL de iframe/embed.
   * Si no se puede desofuscar a stream directo, devuelve la URL de embed sanitizada (ej. mega /embed).
   */
  public static async resolve(iframeUrl: string): Promise<string> {
    const rawUrl = (iframeUrl || "").trim();
    if (!rawUrl) return "";

    // 1. MEGA.NZ: Convertir /file/ a /embed/ para evitar que redirija a la web de Mega
    if (rawUrl.includes("mega.nz/file/")) {
      return rawUrl.replace("mega.nz/file/", "mega.nz/embed/");
    }
    if (rawUrl.includes("mega.nz/embed/")) {
      return rawUrl;
    }

    // 2. VIMEOS.NET: Extraer enlace de descarga directa o stream
    if (rawUrl.includes("vimeos.net/embed-") || rawUrl.includes("vimeos.net/e/")) {
      const match = rawUrl.match(/embed-([a-zA-Z0-9]+)\.html/);
      if (match) {
        return `https://vimeos.net/d/${match[1]}_h`;
      }
    }

    // 3. MP4UPLOAD: Desempaquetar JS de mp4upload para obtener .mp4 directo
    if (rawUrl.includes("mp4upload.com")) {
      const mp4Direct = await this.resolveMp4Upload(rawUrl);
      if (mp4Direct) return mp4Direct;
    }

    // 4. VOE.SX / BYSELAPUIX: Extraer .m3u8 directo
    if (rawUrl.includes("voe.sx") || rawUrl.includes("byselapuix.com") || rawUrl.includes("voe.")) {
      const voeDirect = await this.resolveVoe(rawUrl);
      if (voeDirect) return voeDirect;
    }

    // 5. STREAMTAPE: Extraer token y enlace directo
    if (rawUrl.includes("streamtape.com") || rawUrl.includes("streamtape.to")) {
      const streamtapeDirect = await this.resolveStreamtape(rawUrl);
      if (streamtapeDirect) return streamtapeDirect;
    }

    // 6. STREAMWISH / FILEMOON / VIDMOLY / UPSTREAM / FASTRE / STREAMHIDE
    if (
      rawUrl.includes("streamwish") ||
      rawUrl.includes("filemoon") ||
      rawUrl.includes("vidmoly") ||
      rawUrl.includes("upstream") ||
      rawUrl.includes("fastre") ||
      rawUrl.includes("streamhide")
    ) {
      const unpacked = await this.resolvePackedEmbed(rawUrl);
      if (unpacked) return unpacked;
    }

    // 7. Genérico: intentar extraer .m3u8 o .mp4 del HTML del iframe
    const generic = await this.resolveGeneric(rawUrl);
    return generic || rawUrl;
  }

  /**
   * Resuelve stream directo de MP4Upload
   */
  private static async resolveMp4Upload(url: string): Promise<string | null> {
    try {
      const html = await this.fetchHtml(url);
      if (!html) return null;

      // Buscar script empaquetado
      const unpacked = unpackGeneric(html);
      const match = unpacked.match(/src:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i) ||
                    unpacked.match(/["'](https?:\/\/[a-zA-Z0-9.\-_:]+\/d\/[^"']+\/video\.mp4)["']/i);
      if (match) return match[1];

      const direct = extractMediaUrlsFromCode(unpacked);
      return direct.find((u) => u.includes(".mp4")) || null;
    } catch {
      return null;
    }
  }

  /**
   * Resuelve stream directo de VOE / ByseLapuix
   */
  private static async resolveVoe(url: string): Promise<string | null> {
    try {
      const html = await this.fetchHtml(url);
      if (!html) return null;

      // VOE suele almacenar el m3u8 en 'hls': '...' o base64
      const hlsMatch = html.match(/['"]hls['"]\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i) ||
                       html.match(/['"](https?:\/\/[^'"]+\.m3u8(?:\?[^'"]*)?)['"]/i);
      if (hlsMatch) return hlsMatch[1];

      // Caso Base64 en VOE
      const b64Match = html.match(/prompt\(['"][^'"]*['"],\s*['"]([A-Za-z0-9+/=]{20,})['"]\)/) ||
                       html.match(/sources\s*=\s*JSON\.parse\(atob\(['"]([A-Za-z0-9+/=]+)['"]\)\)/);
      if (b64Match) {
        try {
          const decoded = Buffer.from(b64Match[1], "base64").toString("utf-8");
          const media = extractMediaUrlsFromCode(decoded);
          if (media.length > 0) return media[0];
        } catch {}
      }

      const unpacked = unpackGeneric(html);
      const media = extractMediaUrlsFromCode(unpacked);
      return media.find((u) => u.includes(".m3u8")) || media[0] || null;
    } catch {
      return null;
    }
  }

  /**
   * Resuelve stream directo de Streamtape
   */
  private static async resolveStreamtape(url: string): Promise<string | null> {
    try {
      const html = await this.fetchHtml(url);
      if (!html) return null;

      // Streamtape concatena robotlink: document.getElementById('robotlink').innerHTML = '//streamtape.com/get_video?id=...' + ('&token=...');
      const matchRobot = html.match(/document\.getElementById\(['"](?:robotlink|videolink)['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*['"]([^'"]+)['"]/i);
      if (matchRobot) {
        let streamUrl = matchRobot[1] + matchRobot[2];
        if (streamUrl.startsWith("//")) streamUrl = `https:${streamUrl}`;
        return streamUrl;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Resuelve reproductores con scripts empaquetados tipo Dean Edwards
   */
  private static async resolvePackedEmbed(url: string): Promise<string | null> {
    try {
      const html = await this.fetchHtml(url);
      if (!html) return null;

      const unpacked = unpackGeneric(html);
      const mediaUrls = extractMediaUrlsFromCode(unpacked);
      const m3u8 = mediaUrls.find((u) => u.includes(".m3u8"));
      if (m3u8) return m3u8;

      const mp4 = mediaUrls.find((u) => u.includes(".mp4"));
      if (mp4) return mp4;

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Fallback genérico para iframes
   */
  private static async resolveGeneric(url: string): Promise<string | null> {
    try {
      const html = await this.fetchHtml(url);
      if (!html) return null;

      const unpacked = unpackGeneric(html);
      const mediaUrls = extractMediaUrlsFromCode(unpacked);
      return mediaUrls[0] || null;
    } catch {
      return null;
    }
  }

  private static async fetchHtml(url: string): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.DEFAULT_TIMEOUT);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          ...this.DEFAULT_HEADERS,
          Referer: new URL(url).origin + "/",
        },
      });
      clearTimeout(timer);

      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }
}
