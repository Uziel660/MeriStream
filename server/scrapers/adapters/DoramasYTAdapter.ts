import * as cheerio from "cheerio";
import { BaseScraperAdapter, COMMON_HEADERS } from "../BaseAdapter";
import { UniversalAnalysisResult, ContentKind, ExtractedEpisode, ExtractedCatalogItem } from "../../types";
import { EmbedResolvers } from "../../resolvers";
import { MediaValidator } from "../../validator";

const BASE_URL = "https://www.doramasyt.com";
const SITE_HOST = "doramasyt.com";

/**
 * DoramasYT mantiene sus links de episodio en páginas Laravel y publica los
 * servidores como enlaces externos. El HTML también contiene posters, trackers
 * y tokens cifrados del reproductor; esos valores no son locators reproducibles
 * y se excluyen deliberadamente.
 */
const PLAYABLE_HOSTS = [
  "mega.nz",
  "mega.io",
  "mega.co.nz",
  "pixeldrain.com",
  "gofile.io",
  "bysekoze.com",
  "byseqekaho.com",
  "byselapuix.com",
  "mp4upload.com",
  "yourupload.com",
  "streamtape.com",
  "streamtape.to",
  "doodstream.com",
  "dood.pm",
  "dood.wf",
  "dood.cx",
  "dood.la",
  "dsvplay.com",
  "uqload.com",
  "vidhide.com",
  "vixhide.com",
  "vidmoly.to",
  "luluvid.com",
  "1cloudfile.com",
  "solidfiles.com",
  "1fichier.com",
] as const;

const IGNORED_HOSTS = [
  SITE_HOST,
  "t.me",
  "telegram.me",
  "numbestkarree.com",
  "googlesyndication.com",
  "doubleclick.net",
  "google-analytics.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "cdn.jsdelivr.net",
] as const;

const IMAGE_OR_ASSET = /\.(?:avif|bmp|css|gif|ico|jpe?g|js|png|svg|webp|woff2?)(?:[?#]|$)/i;
const DIRECT_MEDIA = /\.(?:m3u8|mp4|mpd|webm|mkv)(?:[?#]|$)/i;

export class DoramasYTAdapter extends BaseScraperAdapter {
  readonly id = "doramasyt";
  readonly name = "DoramasYT (Doramas en español)";
  readonly supportedDomains = [SITE_HOST];

  canHandle(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      return host === SITE_HOST || host.endsWith(`.${SITE_HOST}`);
    } catch {
      return false;
    }
  }

  public async analyze(input: string, explicitType?: "auto" | "catalog" | "detail" | "stream"): Promise<UniversalAnalysisResult> {
    const cleanUrl = input.trim();
    if (!/^https?:\/\//i.test(cleanUrl)) {
      const items = await this.search(cleanUrl);
      return this.catalogResult(`${cleanUrl} - Buscar`, items, cleanUrl);
    }

    let parsed: URL;
    try {
      parsed = new URL(cleanUrl);
    } catch {
      return this.emptyResult("detail", "series");
    }

    const path = parsed.pathname.toLowerCase();
    const isEpisode = path.startsWith("/ver/") || /(?:episodio|capitulo)[-_]/i.test(path);
    const isCatalog = explicitType === "catalog" || this.isCatalogPath(path);

    if (explicitType === "stream" || isEpisode) {
      const stream = await this.extractStream(cleanUrl);
      return {
        page_type: "direct_stream",
        content_type: "series",
        title: stream.title || this.titleFromSlug(cleanUrl),
        source_domain: SITE_HOST,
        description: "",
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: 0,
        status: "ongoing",
        genres: ["Dorama"],
        detected_streams: stream.all_available_streams,
        episodes: [],
        catalog_items: [],
      };
    }

    const html = await this.fetchHtml(cleanUrl, 10000);
    if (!html) {
      if (isCatalog) throw new Error(`FETCH_FAILED: ${cleanUrl}`);
      return this.emptyResult("detail", "series");
    }

    if (isCatalog) {
      const items = this.extractCatalogItems(html, cleanUrl);
      const isMovie = path === "/peliculas" || path.startsWith("/peliculas/");
      return this.catalogResult(
        this.pageTitle(html) || `Catálogo DoramasYT`,
        items,
        isMovie ? "Películas" : "Doramas",
        isMovie ? "movie" : "series",
      );
    }

    return this.extractDetail(cleanUrl, html);
  }

  public async search(query: string): Promise<ExtractedCatalogItem[]> {
    const value = query.trim();
    if (!value) return [];
    const url = `${BASE_URL}/buscar?q=${encodeURIComponent(value)}`;
    const html = await this.fetchHtml(url, 10000);
    return html ? this.extractCatalogItems(html, url) : [];
  }

  private isCatalogPath(path: string): boolean {
    return path === "/" || path === "/doramas" || path === "/peliculas" ||
      path.startsWith("/genero/") || path.startsWith("/buscar") || path.startsWith("/emision");
  }

  private catalogResult(
    title: string,
    items: ExtractedCatalogItem[],
    description: string,
    contentType: ContentKind = "series",
  ): UniversalAnalysisResult {
    return {
      page_type: "catalog",
      content_type: contentType,
      title,
      source_domain: SITE_HOST,
      description: `Catálogo extraído de DoramasYT${description ? `: ${description}` : ""}`,
      poster_url: null,
      banner_url: null,
      rating: 0,
      year: 0,
      status: "published",
      genres: ["Dorama"],
      episodes: [],
      catalog_items: items,
    };
  }

  private emptyResult(pageType: "detail" | "catalog" | "direct_stream", contentType: ContentKind): UniversalAnalysisResult {
    return {
      page_type: pageType,
      content_type: contentType,
      title: "",
      source_domain: SITE_HOST,
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

  private extractCatalogItems(html: string, baseUrl: string): ExtractedCatalogItem[] {
    const $ = cheerio.load(html);
    const items: ExtractedCatalogItem[] = [];
    const seen = new Set<string>();
    const isMoviePage = (() => {
      try { return new URL(baseUrl).pathname.toLowerCase().startsWith("/peliculas"); } catch { return false; }
    })();

    $("a[href]").each((_, el) => {
      const href = ($(el).attr("href") || "").trim();
      if (!href) return;
      const fullUrl = this.resolveRelativeUrl(href, baseUrl);
      if (!fullUrl || !this.isSameSite(fullUrl)) return;

      let pathname = "";
      try { pathname = new URL(fullUrl).pathname.toLowerCase(); } catch { return; }
      if (!pathname.startsWith("/dorama/") || seen.has(fullUrl)) return;
      seen.add(fullUrl);

      const link = $(el);
      const card = link.closest("article, li, .card, .item, .film, .post, div");
      const img = (card.find("img").first().attr("data-src") || card.find("img").first().attr("data-lazy-src") ||
        card.find("img").first().attr("src") || link.find("img").first().attr("src") || "").trim();
      const title = this.cleanTitle(
        card.find("h1, h2, h3, h4, .title, .name").first().text() ||
        link.attr("title") || link.find("img").first().attr("alt") || link.text() || this.titleFromSlug(fullUrl),
      );
      if (!title || this.isNavigationTitle(title)) return;

      const text = `${card.text()} ${link.parent().text()}`.replace(/\s+/g, " ");
      const year = this.yearFromText(text);
      items.push({
        title,
        url: fullUrl,
        image_url: img ? this.resolveRelativeUrl(img, baseUrl) : null,
        kind: isMoviePage ? "movie" : "series",
        year,
      });
    });

    return items;
  }

  private async extractDetail(url: string, html: string): Promise<UniversalAnalysisResult> {
    const $ = cheerio.load(html);
    const title = this.cleanTitle(
      $("meta[property='og:title']").attr("content") || $("h1").first().text() || $("title").text() || this.titleFromSlug(url),
    );
    const description = $("meta[property='og:description']").attr("content") ||
      $(".sinopsis, .synopsis, .description, .overview").first().text().replace(/\s+/g, " ").trim() || "";
    const rawPoster = $("meta[property='og:image']").attr("content") || $(".poster img, img.poster").first().attr("src") || "";
    const genres: string[] = [];
    $("a[href*='/genero/'], .genres a, .genre a").each((_, el) => {
      const value = $(el).text().replace(/\s+/g, " ").trim();
      if (value && !genres.includes(value)) genres.push(value);
    });

    let episodes = this.extractEpisodes(html, url);
    // DoramasYT deja un enlace SSR de “Ver Ahora” aunque la ficha tenga
    // muchos capítulos. Cuando existe el índice AJAX siempre lo consultamos y
    // fusionamos por número para no importar una serie con solo el capítulo 1.
    if (/data-ajax=["']/i.test(html)) {
      // El intento es acotado y tolera que Cloudflare bloquee el POST: el
      // capítulo directo sigue funcionando y no se inventan episodios cuando
      // el índice no responde.
      const ajaxEpisodes = await this.extractAjaxEpisodes(url, html);
      if (ajaxEpisodes.length > 0) {
        // The AJAX index is authoritative. Some fichas expose alternate
        // language slugs for the same episode number and an SSR teaser that
        // points to episode 0; collapse those variants by number and keep the
        // URL whose slug best matches the detail page.
        const merged = new Map<number, ExtractedEpisode>();
        const ajaxUrls = new Set(ajaxEpisodes.map((episode) => episode.url));
        for (const episode of ajaxEpisodes) {
          const current = merged.get(episode.number);
          if (!current || this.episodeMatchScore(episode.url, url) > this.episodeMatchScore(current.url, url)) {
            merged.set(episode.number, episode);
          }
        }
        for (const episode of episodes) {
          if (ajaxUrls.has(episode.url)) continue;
          const current = merged.get(episode.number);
          if (!current || this.episodeMatchScore(episode.url, url) > this.episodeMatchScore(current.url, url)) {
            merged.set(episode.number, episode);
          }
        }
        episodes = Array.from(merged.values()).sort((a, b) => a.number - b.number);
      }
      if (episodes.length > 1) {
        const uniqueNumbers = new Map<number, ExtractedEpisode>();
        for (const episode of episodes) {
          const current = uniqueNumbers.get(episode.number);
          if (!current || this.episodeMatchScore(episode.url, url) > this.episodeMatchScore(current.url, url)) {
            uniqueNumbers.set(episode.number, episode);
          }
        }
        episodes = Array.from(uniqueNumbers.values()).sort((a, b) => a.number - b.number);
      }
    }

    const isMovie = /\/pel[ií]cula/i.test(url) || /\bpel[ií]cula\b/i.test(title) || episodes.length === 0 && /pel[ií]cula/i.test(description);
    return {
      page_type: "detail",
      content_type: isMovie ? "movie" : "series",
      title,
      source_domain: SITE_HOST,
      description,
      poster_url: rawPoster ? this.resolveRelativeUrl(rawPoster, url) : null,
      banner_url: rawPoster ? this.resolveRelativeUrl(rawPoster, url) : null,
      rating: 0,
      year: this.yearFromText(`${title} ${description}`) || 0,
      status: "published",
      genres: genres.length > 0 ? genres : ["Dorama"],
      episodes,
      catalog_items: [],
    };
  }

  private extractEpisodes(html: string, baseUrl: string): ExtractedEpisode[] {
    const $ = cheerio.load(html);
    const episodes: ExtractedEpisode[] = [];
    const seen = new Set<string>();
    $("a[href*='/ver/']").each((idx, el) => {
      const href = ($(el).attr("href") || "").trim();
      if (!href) return;
      const url = this.resolveRelativeUrl(href, baseUrl);
      if (!url || seen.has(url) || !this.isSameSite(url)) return;
      seen.add(url);
      const number = this.episodeNumber(url) || this.episodeNumber($(el).text()) || idx + 1;
      const label = $(el).text().replace(/\s+/g, " ").trim();
      episodes.push({ number, title: label || `Capítulo ${number}`, url, server_name: "DoramasYT" });
    });
    return episodes.sort((a, b) => a.number - b.number);
  }

  private async extractAjaxEpisodes(detailUrl: string, html: string): Promise<ExtractedEpisode[]> {
    const ajaxMatch = html.match(/data-ajax=["']([^"']+)["']/i);
    if (!ajaxMatch) return [];
    const ajaxUrl = this.resolveRelativeUrl(ajaxMatch[1], detailUrl);
    let csrf = html.match(/name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)?.[1] || "";
    if (!ajaxUrl || !csrf) return [];

    const post = async (target: string, body: URLSearchParams, cookie = ""): Promise<any | null> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(target, {
          method: "POST",
          signal: controller.signal,
          headers: {
            ...COMMON_HEADERS,
            Accept: "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-TOKEN": csrf,
            Referer: detailUrl,
            Origin: BASE_URL,
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: body.toString(),
        });
        if (!response.ok) return null;
        return await response.json();
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };

    // Reuse a fresh page request only to capture Laravel cookies. If it is
    // blocked, retry the AJAX call without Cookie; some mirrors allow that.
    let cookie = "";
    try {
      const page = await fetch(detailUrl, { headers: COMMON_HEADERS });
      // La cookie Laravel y el meta CSRF deben salir de la misma respuesta.
      // Reutilizar el token del HTML anterior provoca 419 aunque la página sea
      // accesible, porque DoramasYT rota ambos valores por visita.
      const freshHtml = await page.text().catch(() => "");
      const freshCsrf = freshHtml.match(/name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)?.[1] || "";
      if (freshCsrf) csrf = freshCsrf;
      const setCookie = page.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(",").map((v) => v.split(";")[0]).join("; ");
    } catch {}

    const first = await post(ajaxUrl, new URLSearchParams({ _token: csrf }), cookie);
    if (!first) return [];

    const payloads: any[] = [first];
    const total = Number(first.eps?.length || first.total || 0);
    const perPage = Math.max(1, Number(first.perpage || total || 50));
    const paginateUrl = typeof first.paginate_url === "string" ? this.resolveRelativeUrl(first.paginate_url, detailUrl) : "";
    if (paginateUrl && total > 0) {
      const pages = Math.min(20, Math.ceil(total / perPage));
      for (let page = 1; page <= pages; page += 1) {
        const result = await post(paginateUrl, new URLSearchParams({ _token: csrf, p: String(page) }), cookie);
        if (result) payloads.push(result);
      }
    }

    const episodes: ExtractedEpisode[] = [];
    const seen = new Set<string>();
    for (const payload of payloads) {
      const rows = [
        ...(Array.isArray(payload?.caps) ? payload.caps : []),
        ...(Array.isArray(payload?.eps) ? payload.eps : []),
        ...(Array.isArray(payload?.data?.caps) ? payload.data.caps : []),
        ...(Array.isArray(payload?.data?.eps) ? payload.data.eps : []),
      ];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const n = Number(row.episodio ?? row.episode ?? row.number ?? row.num);
        if (!Number.isFinite(n) || n < 0) continue;
        const raw = typeof row.url === "string" ? row.url : "";
        const url = raw ? this.resolveRelativeUrl(raw, detailUrl) : this.episodeUrlFromDetail(detailUrl, n);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        episodes.push({ number: n, title: `Capítulo ${n}`, url, server_name: "DoramasYT" });
      }
    }
    return episodes.sort((a, b) => a.number - b.number);
  }

  public async extractStream(targetUrl: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const cleanUrl = targetUrl.trim();
    const html = await this.fetchHtml(cleanUrl, 12000);
    if (!html) return { stream_url: "", all_available_streams: [] };

    const $ = cheerio.load(html);
    const title = this.cleanTitle($("meta[property='og:title']").attr("content") || $("title").text()) || undefined;
    const sourceUrls = this.extractSourceUrls(html, cleanUrl);
    if (sourceUrls.length === 0) return { stream_url: "", all_available_streams: [], title };

    const resolved = await Promise.all(sourceUrls.map(async (source) => {
      const pixeldrain = this.normalizePixeldrain(source);
      if (pixeldrain) {
        return { source, url: pixeldrain, direct: true, resolved: true };
      }
      try {
        const meta = await EmbedResolvers.resolveWithMeta(source);
        if (meta.resolved && meta.url) {
          return { source, url: meta.url, direct: this.isDirectMedia(meta.url), resolved: true };
        }
        // Keep only known browser embeds as a last resort. Download pages such
        // as 1fichier/solidfiles are intentionally excluded from playback.
        return this.isBrowserEmbed(source) ? { source, url: source, direct: false, resolved: false } : null;
      } catch {
        return null;
      }
    }));

    const candidates = resolved.filter((item): item is { source: string; url: string; direct: boolean; resolved: boolean } => Boolean(item));
    const direct = candidates.filter((item) => item.direct).map((item) => item.url);
    const rawEmbeds = candidates.filter((item) => !item.direct).map((item) => item.url);
    const validated = direct.length > 0 ? await MediaValidator.validateUrls(direct) : [];
    const playableDirect = Array.from(new Set(validated.length > 0 ? validated : direct));
    const ordered = Array.from(new Set([...playableDirect, ...rawEmbeds]));

    return {
      stream_url: ordered[0] || "",
      all_available_streams: ordered,
      title,
    };
  }

  private extractSourceUrls(html: string, baseUrl: string): string[] {
    const $ = cheerio.load(html);
    const output: string[] = [];
    const add = (raw: string | undefined) => {
      if (!raw) return;
      let value = raw.replace(/\\\\\//g, "/").replace(/&amp;/gi, "&").trim();
      if (!value || value.startsWith("data:") || value.startsWith("javascript:")) return;
      if (!/^https?:\/\//i.test(value) && value.startsWith("//")) value = `https:${value}`;
      if (!/^https?:\/\//i.test(value)) {
        // data-player values are often encrypted Laravel tokens. Only accept a
        // plain/base64 value when it really decodes to a URL.
        if (/^[A-Za-z0-9+/=_-]{16,}$/.test(value)) {
          try {
            const decoded = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").trim();
            if (/^https?:\/\//i.test(decoded)) value = decoded;
            else return;
          } catch { return; }
        } else return;
      }
      const full = this.resolveRelativeUrl(value, baseUrl);
      if (full && this.isCandidateUrl(full) && !output.includes(full)) output.push(full);
    };

    $("a[href], iframe[src], video[src], video source[src], [data-video], [data-url], [data-src], [data-embed], [data-code], [data-player]").each((_, el) => {
      add($(el).attr("href"));
      add($(el).attr("src"));
      for (const attr of ["data-video", "data-url", "data-src", "data-embed", "data-code", "data-player"]) add($(el).attr(attr));
    });

    // Some server links are embedded in inline JSON/scripts rather than hrefs.
    const urlRegex = /https?:\/\/[^\s"'<>\\]+/gi;
    for (const match of html.match(urlRegex) || []) add(match.replace(/\\u0026/g, "&"));
    return output;
  }

  private isCandidateUrl(rawUrl: string): boolean {
    try {
      const url = new URL(rawUrl);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      const path = url.pathname.toLowerCase();
      if (host === SITE_HOST || host.endsWith(`.${SITE_HOST}`)) return false;
      if (IGNORED_HOSTS.some((ignored) => host === ignored || host.endsWith(`.${ignored}`))) return false;
      if (IMAGE_OR_ASSET.test(path) || /\/(?:thumbs?|poster|backdrop|images?|assets?)\//i.test(path)) return false;
      if (DIRECT_MEDIA.test(rawUrl)) return true;
      return PLAYABLE_HOSTS.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
    } catch {
      return false;
    }
  }

  private isBrowserEmbed(rawUrl: string): boolean {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
      return ["mega.nz", "mega.io", "mega.co.nz", "gofile.io", "pixeldrain.com", "bysekoze.com", "byseqekaho.com", "byselapuix.com", "mp4upload.com", "yourupload.com", "streamtape.com", "doodstream.com", "dood.pm", "dsvplay.com", "uqload.com", "vidhide.com", "vidmoly.to", "luluvid.com"].some((h) => host === h || host.endsWith(`.${h}`));
    } catch {
      return false;
    }
  }

  private normalizePixeldrain(rawUrl: string): string | null {
    try {
      const url = new URL(rawUrl);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (host !== "pixeldrain.com") return null;
      const match = url.pathname.match(/^\/(?:u|file)\/([A-Za-z0-9_-]+)/i);
      return match ? `https://pixeldrain.com/api/file/${match[1]}` : null;
    } catch {
      return null;
    }
  }

  private pageTitle(html: string): string {
    const $ = cheerio.load(html);
    return this.cleanTitle($("meta[property='og:title']").attr("content") || $("title").text());
  }

  private cleanTitle(value: string): string {
    return value.replace(/\s+/g, " ").replace(/\s*\|\s*DoramasYT\s*$/i, "").replace(/\s*[-–—]\s*DoramasYT\s*$/i, "").trim();
  }

  private isNavigationTitle(value: string): boolean {
    return /^(inicio|home|doramas|pel[ií]culas|g[eé]neros?|buscar|login|registr|ver)$/i.test(value.trim());
  }

  private yearFromText(value: string): number | null {
    const match = value.match(/(?:19|20)\d{2}/);
    return match ? Number.parseInt(match[0], 10) : null;
  }

  private episodeNumber(value: string): number | null {
    const match = value.match(/(?:episodio|cap[ií]tulo|episode|ep)[\s_-]*(\d+(?:\.\d+)?)/i) || value.match(/[-_](\d+(?:\.\d+)?)(?:[/?#]|$)/);
    if (!match) return null;
    const number = Number.parseFloat(match[1]);
    return Number.isFinite(number) ? number : null;
  }

  private episodeMatchScore(episodeUrl: string, detailUrl: string): number {
    try {
      const detailSlug = new URL(detailUrl).pathname.split("/").filter(Boolean).pop()!
        .replace(/-sub-espanol$/i, "");
      const episodeSlug = new URL(episodeUrl).pathname.split("/").filter(Boolean).pop()!
        .replace(/-episodio-\d+$/i, "");
      if (!detailSlug || !episodeSlug) return 0;
      if (episodeSlug === detailSlug) return 20;
      if (episodeSlug.startsWith(`${detailSlug}-`)) return 15;
      if (detailSlug.startsWith(`${episodeSlug}-`)) return 10;
      const detailWords = new Set(detailSlug.split("-"));
      return episodeSlug.split("-").filter((word) => detailWords.has(word)).length;
    } catch {
      return 0;
    }
  }

  private episodeUrlFromDetail(detailUrl: string, episode: number): string {
    try {
      const parsed = new URL(detailUrl);
      const slug = parsed.pathname.split("/").filter(Boolean).pop() || "dorama";
      const base = slug.replace(/-sub-espanol$/i, "");
      return `${parsed.origin}/ver/${base}-episodio-${episode}`;
    } catch {
      return `${BASE_URL}/ver/episodio-${episode}`;
    }
  }

  private titleFromSlug(url: string): string {
    try {
      const slug = new URL(url).pathname.split("/").filter(Boolean).pop() || "DoramasYT";
      return slug.replace(/-episodio-\d+$/i, "").replace(/-sub-espanol$/i, "").replace(/-latino$/i, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
    } catch {
      return "DoramasYT";
    }
  }

  private isSameSite(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      return host === SITE_HOST || host.endsWith(`.${SITE_HOST}`);
    } catch {
      return false;
    }
  }

  private resolveRelativeUrl(value: string, base: string): string {
    try { return new URL(value, base).toString(); } catch { return value; }
  }

  private isDirectMedia(url: string): boolean {
    return DIRECT_MEDIA.test(url) || url.includes("/api/v1/stream/mega");
  }
}
