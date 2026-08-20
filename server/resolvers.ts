export class EmbedResolvers {
  private static DEFAULT_TIMEOUT = 12000;
  private static DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };

  private static REGEX_TYPE_A = /["'](https?:\/\/[^"']+)["']\s*\+\s*["']([^"']+)["']/i;
  private static REGEX_TYPE_B = /data-[\w-]+\s*=\s*(?:'({[^']+})'|"({[^"]+})")/gi;

  /**
   * Resuelve la URL real de stream (.m3u8 / .mp4) a partir de una URL de iframe/embed
   */
  public static async resolve(iframeUrl: string): Promise<string> {
    const url = (iframeUrl || "").trim();
    if (!url) return "";

    const lowered = url.toLowerCase();
    if (lowered.includes("zilla-networks.com/m3u8/") || lowered.includes("mega.nz")) {
      return url;
    }

    if (lowered.includes("mp4upload.com")) {
      return await this.extractPattern(url, /src:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
    } else if (lowered.includes("voe.sx") || lowered.includes("byselapuix.com")) {
      return await this.extractPattern(url, /["'](https?:\/\/[^"']+\.(?:m3u8|mp4)(?:[^"']*)?)["']/i);
    } else {
      const generic = await this.resolveGeneric(url);
      return generic || url;
    }
  }

  private static async extractPattern(url: string, pattern: RegExp): Promise<string> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.DEFAULT_TIMEOUT);

      const res = await fetch(url, { signal: controller.signal, headers: this.DEFAULT_HEADERS });
      clearTimeout(timer);

      if (!res.ok) return "";
      const text = await res.text();
      const match = text.match(pattern);
      return match ? match[1] : "";
    } catch {
      return "";
    }
  }

  private static async resolveGeneric(url: string): Promise<string> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.DEFAULT_TIMEOUT);

      const res = await fetch(url, { signal: controller.signal, headers: this.DEFAULT_HEADERS });
      clearTimeout(timer);

      if (!res.ok) return "";
      const html = await res.text();

      const matchA = html.match(this.REGEX_TYPE_A);
      if (matchA) {
        return matchA[1].trim() + matchA[2].trim();
      }

      let matchB: RegExpExecArray | null;
      while ((matchB = this.REGEX_TYPE_B.exec(html)) !== null) {
        try {
          const jsonStr = matchB[1] || matchB[2];
          const data = JSON.parse(jsonStr);
          if (data && typeof data === "object") {
            const mediaUrl = data.mediaUrl || data.media_url || data.video_url;
            if (typeof mediaUrl === "string" && mediaUrl.startsWith("http")) {
              return mediaUrl;
            }
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Ignorar errores en resolución genérica
    }
    return "";
  }
}
