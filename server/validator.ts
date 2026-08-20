export class MediaValidator {
  private constructor() {}
  private static DEFAULT_TIMEOUT = 5000;
  private static VALID_CONTENT_TYPES = [
    "video/",
    "application/vnd.apple.mpegurl",
    "application/x-mpegurl",
    "application/octet-stream",
    "text/html",
  ];

  private static KNOWN_EMBED_HOSTS = [
    "zilla-networks.com",
    "voe.sx",
    "byselapuix.com",
    "mp4upload.com",
    "mega.nz",
    "streamtape.com",
    "ok.ru",
    "vimeo.com",
    "dood.",
  ];

  /**
   * Filtra y valida enlaces directos realizando peticiones HEAD/GET range ultra-rápidas
   */
  public static async validateUrls(urls: string[]): Promise<string[]> {
    if (!urls || urls.length === 0) return [];

    const cleanUrls = Array.from(new Set(urls.map((u) => (u || "").trim()).filter((u) => u.startsWith("http"))));
    const validStreams: string[] = [];

    for (const cleanUrl of cleanUrls) {
      const urlLower = cleanUrl.toLowerCase();

      // 1. Hosts conocidos y playlists M3U8 se aprueban directamente sin delay
      if (this.KNOWN_EMBED_HOSTS.some((host) => urlLower.includes(host)) || urlLower.includes("/m3u8/") || urlLower.includes(".m3u8")) {
        validStreams.push(cleanUrl);
        continue;
      }

      // 2. HEAD / GET Range Check
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.DEFAULT_TIMEOUT);

        let res = await fetch(cleanUrl, {
          method: "HEAD",
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        });

        if (res.status === 405) {
          res = await fetch(cleanUrl, {
            method: "GET",
            signal: controller.signal,
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
              Range: "bytes=0-1",
            },
          });
        }
        clearTimeout(timer);

        if (res.status === 200 || res.status === 206) {
          const contentType = (res.headers.get("content-type") || "").toLowerCase();
          if (this.VALID_CONTENT_TYPES.some((vt) => contentType.includes(vt)) || urlLower.includes(".mp4")) {
            validStreams.push(cleanUrl);
          }
        }
      } catch {
        // En caso de timeout o error de red, continuar sin congelar
      }
    }

    return validStreams;
  }
}
