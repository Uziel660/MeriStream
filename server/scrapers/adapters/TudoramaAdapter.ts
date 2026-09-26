import * as cheerio from "cheerio";
import { BaseScraperAdapter, COMMON_HEADERS } from "../BaseAdapter";
import type { ContentKind, ExtractedCatalogItem, ExtractedEpisode, UniversalAnalysisResult } from "../../types";
import { EmbedResolvers } from "../../resolvers";
import { MediaValidator } from "../../validator";

const BASE_URL = "https://tudorama.com";
const SITE_HOST = "tudorama.com";
const AJAX_URL = `${BASE_URL}/wp-admin/admin-ajax.php`;
const PAGE_SIZE = 20;

/**
 * Tudorama es un WStream/WordPress. Las fichas y los episodios son locators
 * estables; los servidores se solicitan con corvus_get_servers en el momento
 * de reproducir y nunca se guardan en el catálogo.
 */
export class TudoramaAdapter extends BaseScraperAdapter {
  readonly id = "tudorama";
  readonly name = "Tudorama (doramas asiáticos)";
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
    if (!/^https?:\/\//i.test(cleanUrl)) return this.emptyResult("detail", "series");
    let parsed: URL;
    try { parsed = new URL(cleanUrl); } catch { return this.emptyResult("detail", "series"); }
    const path = parsed.pathname.toLowerCase();
    if (explicitType === "stream" || path.startsWith("/ver/")) {
      const stream = await this.extractStream(cleanUrl);
      return { ...this.emptyResult("direct_stream", "series"), title: stream.title || this.titleFromUrl(cleanUrl), source_domain: SITE_HOST, detected_streams: stream.all_available_streams };
    }
    if (explicitType === "catalog" || this.isCatalogPath(path)) return this.extractCatalogResult(cleanUrl);
    const html = await this.fetchHtml(cleanUrl, 12000);
    if (!html) return this.emptyResult("detail", path.startsWith("/pelicula/") ? "movie" : "series");
    return this.extractDetail(cleanUrl, html);
  }

  public override async extractStream(targetUrl: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const cleanUrl = targetUrl.trim();
    if (this.isDirectMedia(cleanUrl)) return { stream_url: cleanUrl, all_available_streams: [cleanUrl], title: this.titleFromUrl(cleanUrl) };
    const html = await this.fetchHtml(cleanUrl, 12000);
    if (!html) return { stream_url: "", all_available_streams: [] };
    const $ = cheerio.load(html);
    const title = this.cleanTitle($('meta[property="og:title"]').attr("content") || $("h1").first().text() || $("title").text()) || undefined;
    const player = $(".ep__dropdown, .servers.movie-player, .servers").first();
    const postId = String(player.attr("data-id") || this.postIdFromBody(html) || "").trim();
    const nonce = String(player.attr("data-nonce") || this.nonceFromHtml(html) || "").trim();
    if (!postId) return { stream_url: "", all_available_streams: [], title };
    const servers = await this.fetchServers(postId, nonce, cleanUrl);
    const candidates: Array<{ url: string; direct: boolean; rank: number }> = [];
    for (const server of servers.slice(0, 8)) {
      const unwrapped = await this.unwrapServer(server.url, cleanUrl);
      if (!unwrapped) continue;
      try {
        const meta = await EmbedResolvers.resolveWithMeta(unwrapped);
        if (meta.resolved && meta.url) candidates.push({ url: meta.url, direct: this.isDirectMedia(meta.url), rank: this.serverRank(server, meta.url) });
        else if (this.isBrowserEmbed(unwrapped)) candidates.push({ url: unwrapped, direct: false, rank: this.serverRank(server, unwrapped) });
      } catch {
        if (this.isBrowserEmbed(unwrapped)) candidates.push({ url: unwrapped, direct: false, rank: this.serverRank(server, unwrapped) });
      }
    }
    const direct = Array.from(new Set(candidates.filter((c) => c.direct).sort((a, b) => a.rank - b.rank).map((c) => c.url)));
    const validated = direct.length ? await MediaValidator.validateUrls(direct) : [];
    const playableDirect = validated.length ? validated : direct;
    const embeds = Array.from(new Set(candidates.filter((c) => !c.direct).sort((a, b) => a.rank - b.rank).map((c) => c.url)));
    const ordered = Array.from(new Set([...playableDirect, ...embeds]));
    return { stream_url: ordered[0] || "", all_available_streams: ordered.slice(0, 4), title };
  }

  private async extractCatalogResult(url: string): Promise<UniversalAnalysisResult> {
    const html = await this.fetchHtml(url, 12000);
    if (!html) throw new Error(`FETCH_FAILED: ${url}`);
    const path = this.pathOf(url);
    const items = this.extractCatalogItems(html, url);
    return {
      ...this.emptyResult("catalog", path.includes("/peliculas") ? "movie" : "series"),
      title: this.pageTitle(html) || "Catálogo Tudorama",
      source_domain: SITE_HOST,
      description: "Catálogo HTML paginado de Tudorama; los índices de idioma son vistas del mismo catálogo.",
      catalog_items: items,
      next_page_url: this.nextPageUrl(html, url),
    };
  }

  private async extractDetail(url: string, html: string): Promise<UniversalAnalysisResult> {
    const $ = cheerio.load(html);
    const path = this.pathOf(url);
    const isMovie = path.startsWith("/pelicula/");
    const title = this.cleanTitle($("meta[property='og:title']").attr("content") || $("h1").first().text() || $("title").text() || this.titleFromUrl(url));
    const description = ($("meta[property='og:description']").attr("content") || $(".description, .synopsis, .sinopsis, .wp-content").first().text() || "").replace(/\s+/g, " ").trim();
    const poster = $("meta[property='og:image']").attr("content") || $(".poster img, .thumb img, img.poster").first().attr("src") || "";
    const genres = Array.from(new Set($("a[href*='/genero/']").map((_, el) => $(el).text().replace(/\s+/g, " ").trim()).get().filter(Boolean)));
    const episodes = isMovie ? [] : await this.extractEpisodes(url, html);
    return { ...this.emptyResult("detail", isMovie ? "movie" : "series"), title, description, poster_url: poster ? this.resolveRelativeUrl(poster, url) : null, banner_url: poster ? this.resolveRelativeUrl(poster, url) : null, year: this.yearFromText($("body").text()), status: /proximamente/i.test($("body").text()) ? "upcoming" : "published", genres: genres.length ? genres : ["Dorama"], episodes };
  }

  private async extractEpisodes(detailUrl: string, html: string): Promise<ExtractedEpisode[]> {
    const $ = cheerio.load(html);
    const rows = new Map<string, ExtractedEpisode>();
    const add = (rawUrl: string, number: number, season: number, label: string) => {
      const url = this.resolveRelativeUrl(rawUrl, detailUrl);
      if (!this.isSameSite(url) || !url.includes("/ver/")) return;
      const key = `${season}:${number}`;
      const current = rows.get(key);
      const item = { number, season, title: label || `Episodio ${number}`, url, server_name: "Tudorama" };
      if (!current || this.episodeScore(url, detailUrl) > this.episodeScore(current.url, detailUrl)) rows.set(key, item);
    };
    $("a[href*='/ver/']").each((idx, el) => {
      const href = $(el).attr("href") || "";
      const text = $(el).text().replace(/\s+/g, " ").trim();
      const number = this.episodeNumber(`${href} ${text}`) || idx + 1;
      const season = this.seasonNumber(`${href} ${$(el).attr("data-season") || ""}`) || 1;
      add(href, number, season, text);
    });
    const containers = $(".eps");
    for (const container of containers.toArray()) {
      const el = $(container);
      const tmdbId = String(el.attr("data-tmdb-id") || "").trim();
      const nonce = String(el.attr("data-nonce") || "").trim();
      const season = Number(el.attr("data-season-number") || 1);
      const results = Math.max(1, Number(el.attr("data-results") || PAGE_SIZE));
      if (!tmdbId || !nonce) continue;
      let offset = 0;
      for (let page = 0; page < 80; page += 1) {
        const payload = await this.fetchEpisodes(tmdbId, season, nonce, results, offset, detailUrl);
        const list = Array.isArray(payload?.data?.results) ? payload.data.results : [];
        for (const row of list) {
          const number = Number(row.episode_number);
          if (!Number.isFinite(number)) continue;
          add(String(row.permalink || ""), number, Number(row.season_number || season), String(row.name || row.title || `Episodio ${number}`));
        }
        if (!payload?.data?.hasMore || list.length === 0) break;
        offset += results;
      }
    }
    return Array.from(rows.values()).sort((a, b) => (a.season || 1) - (b.season || 1) || a.number - b.number);
  }

  private async fetchEpisodes(postId: string, season: number, nonce: string, results: number, offset: number, referer: string): Promise<any | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetch(AJAX_URL, { method: "POST", signal: controller.signal, headers: { ...COMMON_HEADERS, Accept: "application/json, text/javascript, */*; q=0.01", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest", Referer: referer, Origin: BASE_URL }, body: new URLSearchParams({ action: "corvus_get_episodes", nonce, post_id: postId, season: String(season), results: String(results), offset: String(offset), order: "DESC" }).toString() });
      return response.ok ? await response.json() : null;
    } catch { return null; } finally { clearTimeout(timer); }
  }

  private async fetchServers(postId: string, nonce: string, referer: string): Promise<Array<{ url: string; name?: string; lang?: string; type?: string; server?: string }>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetch(AJAX_URL, { method: "POST", signal: controller.signal, headers: { ...COMMON_HEADERS, Accept: "application/json, text/javascript, */*; q=0.01", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest", Referer: referer, Origin: BASE_URL }, body: new URLSearchParams({ action: "corvus_get_servers", nonce, post_id: postId }).toString() });
      if (!response.ok) return [];
      const payload = await response.json();
      const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
      return rows.filter((row: any) => row && typeof row.url === "string").map((row: any) => ({ url: row.url, name: row.name, lang: row.lang, type: row.type, server: row.server }));
    } catch { return []; } finally { clearTimeout(timer); }
  }

  private async unwrapServer(url: string, referer: string): Promise<string | null> {
    if (this.isDirectMedia(url)) return url;
    const html = await this.fetchHtml(url, 9000, { Referer: referer });
    if (!html) return null;
    const $ = cheerio.load(html);
    // WStream deja el iframe vacío y asigna su src dentro de un click handler;
    // buscar esa asignación antes de inspeccionar cualquier <script src="...">
    // evita confundir repro.js con el reproductor real.
    const dynamic = html.match(/iframe\.src\s*=\s*["'](https?:\/\/[^"']+)["']/i)?.[1] ||
      html.match(/iframe\.setAttribute\(\s*["']src["']\s*,\s*["'](https?:\/\/[^"']+)["']/i)?.[1] || "";
    const raw = dynamic || $("iframe").first().attr("src") || $("iframe").first().attr("data-src") || $("video source").first().attr("src") || "";
    return raw ? this.resolveRelativeUrl(raw, url) : null;
  }

  private extractCatalogItems(html: string, baseUrl: string): ExtractedCatalogItem[] {
    const $ = cheerio.load(html);
    const output: ExtractedCatalogItem[] = [];
    const seen = new Set<string>();
    $("a[href*='/serie/'], a[href*='/pelicula/']").each((_, el) => {
      const raw = $(el).attr("href") || "";
      const url = this.resolveRelativeUrl(raw, baseUrl).replace(/#.*$/, "");
      if (!this.isSameSite(url) || seen.has(url)) return;
      const path = this.pathOf(url);
      if (!/^\/(?:serie|pelicula)\/[^/]+\/?$/i.test(path)) return;
      const card = $(el).closest("article, .item, .ipst, .post, li, .c-tabs-item__content, div");
      const title = this.cleanTitle(card.find("h2,h3,h4,.title,.name").first().text() || $(el).attr("title") || $(el).find("img").attr("alt") || $(el).text() || this.titleFromUrl(url));
      if (!title || this.isNavigationTitle(title)) return;
      seen.add(url);
      const img = card.find("img").first();
      const image = img.attr("data-src") || img.attr("data-lazy-src") || img.attr("src") || "";
      const text = card.text().replace(/\s+/g, " ");
      output.push({ title, url, image_url: image ? this.resolveRelativeUrl(image, baseUrl) : null, kind: path.startsWith("/pelicula/") ? "movie" : "series", year: this.yearFromText(text) });
    });
    return output;
  }

  private nextPageUrl(html: string, current: string): string | null {
    const $ = cheerio.load(html);
    const href = $("a.next.page-numbers, a.next, .pagination a[rel='next']").first().attr("href");
    if (href) return this.resolveRelativeUrl(href, current);
    const page = Number(this.pathOf(current).match(/\/page\/(\d+)/)?.[1] || 1);
    const hasNumeric = $("a.page-numbers").toArray().some((el) => Number($(el).text().trim()) === page + 1);
    if (!hasNumeric) return null;
    try {
      const next = new URL(current);
      next.pathname = next.pathname.replace(/\/+$/, "") + `/page/${page + 1}/`;
      return next.toString();
    } catch { return null; }
  }

  private isCatalogPath(path: string): boolean { return path === "/" || path.startsWith("/genero/") || path.startsWith("/page/") || path === "/doramas"; }
  private emptyResult(page_type: UniversalAnalysisResult["page_type"], content_type: ContentKind): UniversalAnalysisResult { return { page_type, content_type, title: "", source_domain: SITE_HOST, description: "", poster_url: null, banner_url: null, rating: 0, year: 0, status: "", genres: [], episodes: [], catalog_items: [] }; }
  private pageTitle(html: string): string { const $ = cheerio.load(html); return this.cleanTitle($("meta[property='og:title']").attr("content") || $("h1").first().text() || $("title").text()); }
  private cleanTitle(value: string): string { return value.replace(/\s+/g, " ").replace(/\s*(?:[|–—-]|»\s*)\s*Tudorama\s*$/i, "").trim(); }
  private titleFromUrl(url: string): string { const slug = this.lastPathPart(url); return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
  private pathOf(url: string): string { try { return new URL(url).pathname.toLowerCase(); } catch { return url.toLowerCase(); } }
  private lastPathPart(url: string): string { return this.pathOf(url).split("/").filter(Boolean).pop() || "Tudorama"; }
  private isSameSite(url: string): boolean { try { const host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); return host === SITE_HOST || host.endsWith(`.${SITE_HOST}`); } catch { return false; } }
  protected resolveRelativeUrl(value: string, base: string): string { try { return new URL(value, base).toString(); } catch { return value; } }
  private yearFromText(value: string): number { const m = value.match(/\b(?:19|20)\d{2}\b/); return m ? Number(m[0]) : 0; }
  private episodeNumber(value: string): number | null { const m = value.match(/(?:episodio|episode|cap(?:itulo|ítulo)?|ep)[-\s_.]*(\d+)/i) || value.match(/s\d+[^\d]+(\d+)/i); return m ? Number(m[1]) : null; }
  private seasonNumber(value: string): number | null { const m = value.match(/(?:season|temporada|s)[\s_-]*(\d+)/i); return m ? Number(m[1]) : null; }
  private episodeScore(episodeUrl: string, detailUrl: string): number { return this.pathOf(episodeUrl).includes(this.lastPathPart(detailUrl)) ? 2 : 1; }
  private postIdFromBody(html: string): string { return html.match(/postid-(\d+)/i)?.[1] || ""; }
  private nonceFromHtml(html: string): string { return html.match(/data-nonce=["']([^"']+)["']/i)?.[1] || ""; }
  private isDirectMedia(url: string): boolean { return /\.(?:m3u8|mp4|mpd|webm|mkv)(?:[?#]|$)/i.test(url) || /\/hls\d?\//i.test(url); }
  private isBrowserEmbed(url: string): boolean { try { const host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); return ["bysesukior.com", "minochinos.com", "abyssplayer.com", "hgcloud.to"].some((h) => host === h || host.endsWith(`.${h}`)); } catch { return false; } }
  private serverRank(server: { name?: string; server?: string; lang?: string }, url: string): number { const key = `${server.name || ""} ${server.server || ""} ${url}`.toLowerCase(); return /filemoon|bysesukior/.test(key) ? 1 : /earnvids|minochinos/.test(key) ? 2 : /abyss/.test(key) ? 50 : /streamhg|hgcloud/.test(key) ? 90 : 20; }
  private isNavigationTitle(value: string): boolean { return /^(inicio|home|series|pel[ií]culas|doramas|ver|buscar|siguiente|anterior)$/i.test(value.trim()); }
}
