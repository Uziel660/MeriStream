export interface PageObservation {
  target_url: string;
  title?: string;
  media_sources?: Array<{ url: string; mime_type: string }>;
  iframe_embeds?: Array<{ src: string; domain_provider: string }>;
  inline_json_snippets?: string[];
}

export interface ExtractionPlan {
  strategy_name: "direct_media" | "resolve_iframes" | "parse_inline_json" | "unknown_fallback";
  target_urls: string[];
}

export class StrategyRouter {
  private constructor() {}
  public static readonly KNOWN_HOSTS: string[] = [
    "zilla-networks.com",
    "voe.sx",
    "byselapuix.com",
    "mp4upload.com",
    "mega.nz",
    "streamtape.com",
    "ok.ru",
    "vimeo.com",
    "doodstream.com",
    "dood.",
    "streamwish.",
    "filemoon.",
    "yourupload.com",
    "vidmoly.",
    "luluvdo.",
    "streamhide.",
  ];

  private static isValidMediaUrl(url: string): boolean {
    if (!url || url.length < 15) return false;
    try {
      const parsed = new URL(url);
      return Boolean(parsed.hostname?.includes("."));
    } catch {
      return false;
    }
  }

  /**
   * Determina el plan de acción secuencial según la jerarquía de prioridades:
   * 1. Medios directos válidos (.mp4 / .m3u8 detectados).
   * 2. Iframes / Embeds decodificados (servidores conocidos o genéricos).
   * 3. Parseo de snippets JSON locales en memoria.
   * 4. Fallback desconocido.
   */

  private static extractDirectStreams(obs: PageObservation): string[] {
    if (!obs.media_sources || obs.media_sources.length === 0) return [];

    return obs.media_sources.filter(m =>
      this.isValidMediaUrl(m.url) &&
      (m.mime_type.toLowerCase().includes("video") || m.mime_type.toLowerCase().includes("mpegurl") || m.url.toLowerCase().includes(".m3u8") || m.url.toLowerCase().includes(".mp4"))
    ).map(m => m.url);
  }

  private static extractIframeTargets(obs: PageObservation): string[] {
    if (!obs.iframe_embeds || obs.iframe_embeds.length === 0) return [];

    const knownTargets: string[] = [];
    const genericTargets: string[] = [];

    for (const iframe of obs.iframe_embeds) {
      const srcClean = iframe.src.trim();
      if (!srcClean.startsWith("http")) continue;

      const lowered = srcClean.toLowerCase();
      if (this.KNOWN_HOSTS.some((host) => lowered.includes(host))) {
        knownTargets.push(srcClean);
      } else if (!["recaptcha", "google", "analytics", "adservice"].some((bad) => lowered.includes(bad))) {
        genericTargets.push(srcClean);
      }
    }

    return knownTargets.length > 0 ? knownTargets : genericTargets;
  }

  public static determinePlan(obs: PageObservation): ExtractionPlan {
    const validDirectVideos = this.extractDirectStreams(obs);
    const uniqueDirect = Array.from(new Set(validDirectVideos));

    if (uniqueDirect.length > 0) {
      return { strategy_name: "direct_media", target_urls: uniqueDirect };
    }

    const selectedIframes = this.extractIframeTargets(obs);
    const uniqueIframes = Array.from(new Set(selectedIframes));

    if (uniqueIframes.length > 0) {
      return { strategy_name: "resolve_iframes", target_urls: uniqueIframes };
    }

    if (obs.inline_json_snippets && obs.inline_json_snippets.length > 0) {
      return { strategy_name: "parse_inline_json", target_urls: [] };
    }

    return { strategy_name: "unknown_fallback", target_urls: [] };
  }

}
