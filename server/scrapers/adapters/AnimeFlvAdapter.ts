import * as cheerio from "cheerio";
import { BaseScraperAdapter, COMMON_HEADERS } from "../BaseAdapter";
import { UniversalAnalysisResult, ExtractedEpisode, ExtractedCatalogItem } from "../../types";
import { cleanQueryTitle, enrichUniversalMetadata } from "../../metadataEngine";
import { PageClassifier } from "../../pageClassifier";
import { MediaValidator } from "../../validator";
import { EmbedResolvers } from "../../resolvers";

/**
 * Hosts de embebido conocidos (espejo ampliado de validator.KNOWN_EMBED_HOSTS +
 * dominios espejo observados hoy en producción: sfastwish/vidhidevip/mdbekjwqa/d-s.io).
 * Los embeds conocidos son reproducibles tal cual y no necesitan resolución.
 */
const KNOWN_EMBED_HOSTS = [
  "zilla-networks.com",
  "voe.",
  "byselapuix.com",
  "mp4upload.com",
  "mega.nz",
  "vidmoly.",
  "luluvdo.",
  "streamhide.",
  "ok.ru",
  "vimeo.com",
  "dood.",
  "doodstream.",
  "fembed.",
  "mixdrop.",
  "uqload.",
  "upstream.",
  "embedsito.",
  "streamlare.",
  "fastre.",
  "gamovideo.",
  "netu.",
  "waaw.",
  "streamdav.",
  "streamhub.",
  "streamwish.",
  "filemoon.",
  // Espejos reales detectados hoy
  "sfastwish.com",
  "vidhidevip.com",
  "mdbekjwqa.pw",
  "hlswish.com",
  "goodstream.one",
  "playmudos.com",
];

/** Dominios de DESCARGA (no reproducibles en iframe): se excluyen de los streams. */
const DOWNLOAD_ONLY_HOSTS = ["mediafire.com", "drive.google.com", "4shared.com", "zippyshare.com"];

const DEAD_OR_BLOCKED_HOST_PATTERNS = [
  /cfglobalcdn\.com/i,
  /yourupload\.com/i,
  /streamtape\./i,
  /dsvplay\.com/i,
  /savefiles\.com/i,
  /d-s\.io/i,
  /a\d+\.mp4upload\.com/i,
  /vidcache\.net/i,
  /my\.mail\.ru/i,
  /v\.tioanime\.com/i,
];

const isKnownEmbedHost = (url: string) =>
  KNOWN_EMBED_HOSTS.some((h) => url.toLowerCase().includes(h));
const isDownloadOnly = (url: string) =>
  DOWNLOAD_ONLY_HOSTS.some((h) => url.toLowerCase().includes(h));
const isDeadOrBlocked = (url: string) =>
  DEAD_OR_BLOCKED_HOST_PATTERNS.some((p) => p.test(url));

export class AnimeFlvAdapter extends BaseScraperAdapter {
  readonly id = "animeflv";
  readonly name = "AnimeFLV / Anime Streaming";
  readonly supportedDomains = ["animeflv.net", "animeflv.or.at", "animeflv.me", "animeflv.ac", "animeflv.to", "jkanime.net"];

  /** Límite de páginas consultadas al AJAX de episodios de jkanime (16 eps/página). */
  private static readonly JK_PAGES = 2;

  canHandle(url: string): boolean {
    const lower = url.toLowerCase();
    return (
      lower.includes("animeflv.") ||
      lower.includes("jkanime.")
    );
  }

  async analyze(input: string, explicitType?: "auto" | "catalog" | "detail" | "stream"): Promise<UniversalAnalysisResult> {
    const urlOrQuery = input.trim();
    const urlObj = new URL(urlOrQuery);
    const domain = urlObj.hostname.toLowerCase();
    const isJkanime = domain.includes("jkanime");

    const html = await this.fetchHtml(urlOrQuery);
    if (!html) {
      return this.fallbackSearch(urlOrQuery);
    }

    const $ = cheerio.load(html);

    // 1. OpenGraph & Meta Tags
    const ogTitle = $('meta[property="og:title"]').attr("content") || $('meta[name="twitter:title"]').attr("content") || $("title").text() || "";
    const ogDesc = $('meta[property="og:description"]').attr("content") || $('meta[name="twitter:description"]').attr("content") || $('meta[name="description"]').attr("content") || "";
    const ogImage = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || "";

    // 2. Extract Streams from AnimeFLV JavaScript `var videos = ...` or DOM
    const detectedStreams = this.extractAnimeflvStreams($, html, urlOrQuery);

    // 3. Extract Episodes: jkanime usa un AJAX paginado con CSRF; animeflv usa
    // `var anime_info`/`var episodes` o el DOM.
    const extractedEpisodes = isJkanime
      ? await this.extractJkanimeEpisodes(html, urlObj)
      : this.extractAnimeflvEpisodes($, html, urlObj);

    // 4. Extract Catalog Items
    const catalogItems: ExtractedCatalogItem[] = [];
    const seenUrls = new Set<string>();

    const cardSelectors = [
      "ul.ListAnimes > li",
      "article.anime",
      "article",
      ".anime-card",
      ".item",
      ".film",
      ".card",
      "li.anime",
      "ul.animes > li",
      ".list-animes > li",
      ".ht_grid_1_4",
      ".post",
      ".hentry",
      ".type-post",
      ".List-Episodes > div",
      ".listCats > div",
      ".browse-item"
    ];

    let cards = $([]);
    for (const selector of cardSelectors) {
      const found = $(selector);
      if (found.length >= 3) {
        cards = found;
        break;
      }
    }

    if (cards.length === 0) {
      for (const selector of cardSelectors) {
        const found = $(selector);
        if (found.length > 0) {
          cards = found;
          break;
        }
      }
    }

    cards.each((_, card) => {
      const item = this.extractAnimeflvCard($, card, urlObj.origin);
      if (item && !seenUrls.has(item.url)) {
        seenUrls.add(item.url);
        catalogItems.push(item);
      }
    });

    const classifiedType = PageClassifier.classify(urlOrQuery, $);
    const isCatalog =
      explicitType === "catalog" ||
      (explicitType !== "detail" &&
        (classifiedType === "collection" ||
          (catalogItems.length >= 3 && extractedEpisodes.length === 0) ||
          urlOrQuery.includes("/page/") ||
          urlOrQuery.includes("?page=")));

    const pageType: UniversalAnalysisResult["page_type"] = isCatalog ? "catalog" : "detail";

    // Validate streams
    const validatedStreams = await MediaValidator.validateUrls(detectedStreams);
    const finalStreams = validatedStreams.length > 0 ? validatedStreams : detectedStreams;

    if (isCatalog) {
      const catalogPoster = ogImage ? (ogImage.startsWith("//") ? `https:${ogImage}` : ogImage) : (catalogItems[0]?.image_url || null);
      return {
        page_type: "catalog",
        content_type: "anime",
        title: ogTitle || `Catálogo Anime (${domain})`,
        description: ogDesc || `Directorio de ${catalogItems.length} animes en ${domain}.`,
        poster_url: catalogPoster,
        banner_url: catalogPoster,
        rating: 8.8,
        year: new Date().getFullYear(),
        status: "Catálogo",
        genres: ["Anime", "Catálogo"],
        source_domain: domain,
        detected_streams: [],
        episodes: [],
        catalog_items: catalogItems,
        raw_metadata: { og: { title: ogTitle, description: ogDesc, image: ogImage }, embeds: [] },
      };
    }

    // Detail page
    const rawCleanTitle = cleanQueryTitle($("h1.Title, h1.entry-title, h1").first().text().trim() || ogTitle || urlObj.pathname.split("/").filter(Boolean).pop() || "Anime");
    const enriched = await enrichUniversalMetadata(rawCleanTitle, "anime");

    // WordPress theme metadata (animeflv.or.at): fuentes primarias del theme
    const wpTitle = $("h1.anime-title").first().text().trim() || undefined;
    const wpPosterRaw = $("img.poster-image").attr("src") || $("img.poster-image").attr("data-src") || undefined;
    const wpPoster = wpPosterRaw
      ? (wpPosterRaw.startsWith("//") ? `https:${wpPosterRaw}` : wpPosterRaw.startsWith("http") ? wpPosterRaw : new URL(wpPosterRaw, urlOrQuery).toString())
      : undefined;
    const wpSynopsis = $(".anime-synopsis p").first().text().trim() || undefined;
    const wpGenres: string[] = [];
    $("span.genre-tag").each((_, el) => {
      const g = $(el).text().trim();
      if (g) wpGenres.push(g);
    });
    const wpRatingRaw = $(".anime-rating .rating-score").first().text().trim();
    const wpRating = parseFloat(wpRatingRaw) || undefined;

    let finalEpisodes = extractedEpisodes;
    if (finalEpisodes.length === 0) {
      if (detectedStreams.length > 0) {
        finalEpisodes = detectedStreams.map((st, idx) => ({
          number: idx + 1,
          title: `Episodio ${idx + 1}`,
          url: st,
        }));
      } else {
        finalEpisodes = [{ number: 1, title: "Episodio 1", url: urlOrQuery }];
      }
    }

    return {
      page_type: pageType,
      content_type: "anime",
      title: wpTitle || enriched.title || rawCleanTitle,
      original_title: enriched.original_title,
      japanese_title: enriched.japanese_title,
      english_title: enriched.english_title,
      description: wpSynopsis || enriched.description || ogDesc || "Serie de anime indexada desde AnimeFLV.",
      poster_url: wpPoster || enriched.poster_url || (ogImage ? (ogImage.startsWith("//") ? `https:${ogImage}` : ogImage) : null),
      banner_url: enriched.banner_url || wpPoster || (ogImage ? (ogImage.startsWith("//") ? `https:${ogImage}` : ogImage) : null),
      rating: wpRating || enriched.rating || 8.5,
      year: enriched.year || 2024,
      status: enriched.status || "En emisión",
      genres: wpGenres.length > 0 ? wpGenres : (enriched.genres.length > 0 ? enriched.genres : ["Anime", "Animación"]),
      source_domain: domain,
      detected_streams: finalStreams,
      episodes: finalEpisodes,
      catalog_items: catalogItems,
      raw_metadata: { og: { title: ogTitle, description: ogDesc, image: ogImage }, embeds: finalStreams },
    };
  }

  async extractStream(url: string): Promise<{ stream_url: string; all_available_streams: string[] }> {
    const cleanUrl = url.trim();

    // jkanime tiene su propio mecanismo de servidores (var servers + jkplayer)
    if (cleanUrl.toLowerCase().includes("jkanime.")) {
      return this.extractJkanimeStream(cleanUrl);
    }

    const html = await this.fetchHtml(cleanUrl);
    if (!html) {
      const mirrored = await this.extractViaJkanimeMirror(cleanUrl);
      if (mirrored) return mirrored;
      return { stream_url: cleanUrl, all_available_streams: [cleanUrl] };
    }

    const $ = cheerio.load(html);
    const rawStreams = this.extractAnimeflvStreams($, html, cleanUrl);

    if (rawStreams.length === 0) {
      // EVIDENCIA 2026-08-21: www3/www4/m.animeflv.net sirven `var videos = []` para
      // muchas IPs (servidores retenidos server-side). Espejo contra jkanime antes
      // de devolver la página del episodio como pseudo-stream.
      const mirrored = await this.extractViaJkanimeMirror(cleanUrl);
      if (mirrored) return mirrored;
      return { stream_url: cleanUrl, all_available_streams: [cleanUrl] };
    }

    const { directStreams, embedStreams } = await this.resolveCandidates(rawStreams);
    const finalStreams = Array.from(new Set([...directStreams, ...embedStreams]));

    return {
      stream_url: finalStreams[0] || cleanUrl,
      all_available_streams: finalStreams.length > 0 ? finalStreams : [cleanUrl],
    };
  }

  /**
   * Clasifica candidatos: embeds conocidos pasan tal cual (regla de oro), los demás
   * se resuelven en paralelo (acotado) buscando upgrades a .m3u8/.mp4 directo.
   * Excepción mp4upload: el embed se conserva como fallback pero su página expone
   * el .mp4 directo en JS plano (player.src), así que también se intenta resolver.
   * IMPORTANTE: el chequeo de host conocido va ANTES del de medio directo porque
   * algunos embeds usan extensiones falsas en el path (streamtape /e/{id}/x.mp4 es
   * una página HTML, no un archivo); clasificarlos como directos pone una página
   * muerta como stream principal (MEDIA_ERR_SRC_NOT_SUPPORTED).
   */
  private async resolveCandidates(rawStreams: string[]): Promise<{ directStreams: string[]; embedStreams: string[] }> {
    const directStreams: string[] = [];
    const embedStreams: string[] = [];
    const needResolve: string[] = [];
    const mp4UploadTargets: string[] = [];

    for (const st of rawStreams) {
      const normalized = this.normalizeServerUrl(st);
      if (!normalized.startsWith("http")) continue;
      if (isDownloadOnly(normalized) || isDeadOrBlocked(normalized)) continue;
      if (normalized.toLowerCase().includes("mp4upload.com")) {
        const target = this.toMp4UploadEmbedUrl(normalized);
        if (!mp4UploadTargets.includes(target)) mp4UploadTargets.push(target);
        if (!embedStreams.includes(normalized)) embedStreams.push(normalized);
      } else if (isKnownEmbedHost(normalized)) {
        if (!embedStreams.includes(normalized)) embedStreams.push(normalized);
      } else if (EmbedResolvers.isDirectMediaUrl(normalized)) {
        if (!directStreams.includes(normalized)) directStreams.push(normalized);
      } else if (!needResolve.includes(normalized)) {
        needResolve.push(normalized);
      }
    }

    const targets = needResolve.slice(0, 6);
    const results = await Promise.allSettled([
      ...targets.map((t) => EmbedResolvers.resolveWithMeta(t)),
      ...mp4UploadTargets.map((t) => EmbedResolvers.resolveWithMeta(t)),
    ]);
    results.forEach((r) => {
      if (r.status !== "fulfilled") return;
      const meta = r.value;
      if (!meta.url || isDeadOrBlocked(meta.url)) return;
      if (meta.resolved && meta.type === "direct") {
        if (!directStreams.includes(meta.url)) directStreams.push(meta.url);
      } else if (meta.url && !embedStreams.includes(meta.url)) {
        embedStreams.push(meta.url);
      }
    });

    // Candidatos desconocidos fuera del lote resuelto: se conservan como embeds
    for (const extra of needResolve.slice(6)) {
      if (!embedStreams.includes(extra)) embedStreams.push(extra);
    }

    return { directStreams, embedStreams };
  }

  /**
   * mp4upload: la página con el .mp4 directo es /embed-{code}.html; la variante
   * plana /{code} solo sirve el HTML de descarga (sin player).
   */
  private toMp4UploadEmbedUrl(url: string): string {
    const m = url.match(/mp4upload\.com\/(?:embed-)?([a-z0-9]+)(?:\.html?)?$/i);
    if (!m) return url;
    return `https://www.mp4upload.com/embed-${m[1]}.html`;
  }

  private normalizeServerUrl(raw: string): string {
    let u = (raw || "").trim().replace(/\\/g, "");
    if (u.includes("mega.nz/#!")) {
      u = u.replace("mega.nz/#!", "mega.nz/embed/#!");
    } else if (u.includes("mega.nz/file/")) {
      u = u.replace("mega.nz/file/", "mega.nz/embed/");
    } else if (u.includes("yourupload.com/watch/")) {
      u = u.replace("yourupload.com/watch/", "yourupload.com/embed/");
    } else if (u.includes("streamtape.com/v/")) {
      u = u.replace("streamtape.com/v/", "streamtape.com/e/");
    }
    return u;
  }

  /* ===================== jkanime ===================== */

  /**
   * Episodios de jkanime: el listado completo llega por AJAX paginado
   * (POST /ajax/episodes/{animeId}/{page} con _token CSRF + cookie de sesión).
   * El HTML crudo solo incluye el último episodio publicado.
   */
  private async extractJkanimeEpisodes(html: string, urlObj: URL): Promise<ExtractedEpisode[]> {
    try {
      const idMatch = html.match(/ajax\/episodes\/(\d+)\//);
      if (!idMatch) return [];

      // La sesión y el token deben provenir de la MISMA respuesta
      const { html: freshHtml, cookie } = await this.fetchWithCookies(urlObj.toString());
      const source = freshHtml ?? html;
      const token = source.match(/name="csrf-token" content="([^"]+)"/)?.[1] || "";
      const animeId = source.match(/ajax\/episodes\/(\d+)\//)?.[1] || idMatch[1];
      if (!token) return [];

      const parts = urlObj.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
      const slug = parts[parts.length - 1] || "anime";
      const origin = urlObj.origin;

      const episodes: ExtractedEpisode[] = [];
      const seen = new Set<number>();

      for (let page = 1; page <= AnimeFlvAdapter.JK_PAGES; page++) {
        const data = await this.jkanimeEpisodesPage(origin, animeId, page, token, cookie);
        if (!data || !Array.isArray(data.data)) break;

        for (const ep of data.data) {
          const num = Number(ep?.number);
          if (!Number.isFinite(num) || num <= 0 || seen.has(num)) continue;
          seen.add(num);
          const title = typeof ep?.title === "string" && ep.title.trim() ? ep.title.trim() : `Episodio ${num}`;
          episodes.push({
            number: num,
            title,
            url: `${origin}/${encodeURIComponent(slug)}/${num}/`,
          });
        }

        const lastPage = Number(data.last_page);
        if (Number.isFinite(lastPage) && page >= lastPage) break;
      }

      return episodes.sort((a, b) => a.number - b.number);
    } catch {
      return [];
    }
  }

  /** GET que captura Set-Cookie junto al HTML (necesario para el CSRF de Laravel). */
  private async fetchWithCookies(
    url: string,
    timeoutMs = 9000
  ): Promise<{ html: string | null; cookie: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: COMMON_HEADERS });
      clearTimeout(timer);
      const raw =
        typeof res.headers.getSetCookie === "function"
          ? res.headers.getSetCookie()
          : [res.headers.get("set-cookie")].filter(Boolean) as string[];
      const cookie = raw
        .map((c) => c.split(";")[0].trim())
        .filter(Boolean)
        .join("; ");
      if (!res.ok) return { html: null, cookie };
      return { html: await res.text(), cookie };
    } catch {
      clearTimeout(timer);
      return { html: null, cookie: "" };
    }
  }

  private async jkanimeEpisodesPage(
    origin: string,
    animeId: string,
    page: number,
    token: string,
    cookie: string
  ): Promise<{ data?: Array<{ number?: unknown; title?: unknown }>; last_page?: unknown } | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      const res = await fetch(`${origin}/ajax/episodes/${animeId}/${page}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          ...COMMON_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          Referer: `${origin}/`,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: new URLSearchParams({ _token: token }).toString(),
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      return (await res.json()) as { data?: Array<{ number?: unknown; title?: unknown }>; last_page?: unknown };
    } catch {
      return null;
    }
  }

  /**
   * Streams de una página de episodio jkanime:
   * 1. `var servers = [{remote: <base64>, server: "..."}]` (mega/voe/mp4upload/streamtape/...)
   * 2. Iframes reales y cadenas JS tipo video[0] = '<iframe src="...jkplayer/um?..."'
   * Cada wrapper jkplayer resuelve internamente a un .m3u8 directo.
   */
  private async extractJkanimeStream(url: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const html = await this.fetchHtml(url, 12000);
    if (!html) return { stream_url: url, all_available_streams: [url] };

    const title = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/)?.[1];
    const rawStreams = this.parseJkanimeServers(html);

    if (rawStreams.length === 0) {
      return { stream_url: url, all_available_streams: [url], title };
    }

    const { directStreams, embedStreams } = await this.resolveCandidates(rawStreams);
    const finalStreams = Array.from(new Set([...directStreams, ...embedStreams]));

    return {
      stream_url: finalStreams[0] || url,
      all_available_streams: finalStreams.length > 0 ? finalStreams : [url],
      title,
    };
  }

  private parseJkanimeServers(html: string): string[] {
    const streams: string[] = [];
    const push = (raw: string) => {
      const clean = this.normalizeServerUrl(raw);
      if (clean.startsWith("http") && !isDownloadOnly(clean) && !streams.includes(clean)) {
        streams.push(clean);
      }
    };

    // 1. var servers = [{remote: base64}]
    const serversMatch = html.match(/var\s+servers\s*=\s*(\[[\s\S]*?\]);\s*(?:var|<\/script>)/);
    if (serversMatch) {
      try {
        const arr = JSON.parse(serversMatch[1]);
        for (const srv of arr) {
          if (!srv?.remote) continue;
          try {
            const decoded = Buffer.from(String(srv.remote), "base64").toString("utf-8").trim();
            if (/^https?:\/\//i.test(decoded)) push(decoded);
          } catch {}
        }
      } catch {}
    }

    // 2. Iframes reales del DOM
    const $ = cheerio.load(html);
    $("iframe").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src");
      if (src) push(src);
    });

    // 3. Iframes dentro de strings JS (video[0] = '<iframe src="...">') y wrappers jkplayer.
    // Se excluye /jkplayer/c1?u= porque en el HTML es una PLANTILLA de concatenación
    // (`'...c1?u='+val.remote+'&s='+...`): el match captura el parámetro vacío y produce
    // un wrapper no reproducible.
    const jsIframe = /<iframe[^>]+src=["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = jsIframe.exec(html)) !== null) {
      if (/jkanime\.net\/jkplayer\/[^"']*?\?(?:[^"']*&)?u=$/i.test(m[1])) continue;
      push(m[1]);
    }
    const jkPlayer = /https?:\/\/jkanime\.net\/jkplayer\/[^\s"'<>\\]+/gi;
    while ((m = jkPlayer.exec(html)) !== null) {
      if (/jkanime\.net\/jkplayer\/[^?]*\?[^#]*&?u=$/i.test(m[0])) continue;
      push(m[0]);
    }

    return streams;
  }

  /**
   * Espejo animeflv -> jkanime: dado `/ver/{slug}-{n}` busca el título en jkanime
   * (/buscar?q=) y extrae los servidores del episodio equivalente `{slug}/{n}/`.
   */
  private async extractViaJkanimeMirror(
    afUrl: string
  ): Promise<{ stream_url: string; all_available_streams: string[] } | null> {
    try {
      const u = new URL(afUrl);
      const parts = u.pathname.split("/").filter(Boolean);
      const verIdx = parts.findIndex((p) => p.toLowerCase() === "ver");
      const tail = verIdx >= 0 ? parts[verIdx + 1] : undefined;
      if (!tail) return null;

      const numMatch = tail.match(/-(\d+(?:\.\d+)?)$/);
      if (!numMatch) return null;
      const epNum = parseFloat(numMatch[1]);
      const slug = tail.slice(0, tail.length - numMatch[0].length).toLowerCase();
      if (!slug) return null;

      const candidates = await this.searchJkanime(slug.replace(/-/g, " "));
      for (const animeUrl of candidates.slice(0, 3)) {
        const epUrl = `${animeUrl.replace(/\/+$/, "")}/${epNum}/`;
        const html = await this.fetchHtml(epUrl, 12000);
        if (!html) continue;

        const rawStreams = this.parseJkanimeServers(html);
        if (rawStreams.length === 0) continue;

        const { directStreams, embedStreams } = await this.resolveCandidates(rawStreams);
        const finalStreams = Array.from(new Set([...directStreams, ...embedStreams]));
        if (finalStreams.length > 0) {
          return { stream_url: finalStreams[0], all_available_streams: finalStreams };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Búsqueda en jkanime (/buscar?q=): tarjetas .anime__item con enlaces raíz de anime. */
  private async searchJkanime(query: string): Promise<string[]> {
    const html = await this.fetchHtml(
      `https://jkanime.net/buscar?q=${encodeURIComponent(query)}`,
      10000
    );
    if (!html) return [];

    const results: string[] = [];
    const $ = cheerio.load(html);
    $(".anime__item a[href]").each((_, el) => {
      const href = ($(el).attr("href") || "").trim();
      if (/^https?:\/\/jkanime\.net\/[^/]+\/?$/i.test(href)) {
        const clean = href.replace(/\/+$/, "") + "/";
        if (!results.includes(clean)) results.push(clean);
      }
    });
    if (results.length === 0) {
      const regex = /href="(https?:\/\/jkanime\.net\/[a-z0-9\-]+\/)"/gi;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(html)) !== null) {
        const clean = m[1].replace(/\/+$/, "") + "/";
        if (!results.includes(clean)) results.push(clean);
      }
    }
    return results;
  }

  /* ===================== animeflv ===================== */

  /**
   * WordPress theme (animeflv.or.at) sirve servidores codificados en base64
   * dentro de botones y contenedores DOM.
   */
  private extractWordPressServers($: cheerio.CheerioAPI): string[] {
    const servers: string[] = [];
    const seen = new Set<string>();

    const pushDecoded = (raw: string) => {
      const trimmed = (raw || "").trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      try {
        const decoded = Buffer.from(trimmed, "base64").toString("utf-8").trim();
        if (/^https?:\/\//i.test(decoded)) {
          servers.push(decoded);
        }
      } catch {}
    };

    $("button.iframe_code[data-src]").each((_, el) => {
      const val = $(el).attr("data-src") || "";
      if (val) pushDecoded(val);
    });

    $("#iframeHolder[data-default-src]").each((_, el) => {
      const val = $(el).attr("data-default-src") || "";
      if (val) pushDecoded(val);
    });

    return servers;
  }

  private extractAnimeflvStreams($: cheerio.CheerioAPI, html: string, baseUrl: string): string[] {
    const streams: string[] = [];

    // 1. var videos = { "SUB": [ ... ] }
    const videoObjectMatch = html.match(/var\s+videos\s*=\s*(\{.+?\});/s) || html.match(/videos\s*=\s*(\{.+?\});/s);
    if (videoObjectMatch) {
      try {
        const parsed = JSON.parse(videoObjectMatch[1]);
        const serverGroups = [parsed.SUB, parsed.LAT, parsed.ENG, ...Object.values(parsed)].filter(Boolean);
        for (const grp of serverGroups) {
          if (Array.isArray(grp)) {
            grp.forEach((srv: any) => {
              const link = srv.code || srv.url;
              if (link && typeof link === "string") {
                const clean = this.normalizeServerUrl(link);
                if (clean.startsWith("http") && !streams.includes(clean)) streams.push(clean);
              }
            });
          }
        }
      } catch {}
    }

    // 2. var videos = [ ["Server", "https://..."], ... ]
    const videoArrayMatch = html.match(/var\s+videos\s*=\s*(\[.+?\]);/s);
    if (videoArrayMatch) {
      try {
        const parsed = JSON.parse(videoArrayMatch[1].replace(/'/g, '"'));
        if (Array.isArray(parsed)) {
          parsed.forEach((entry: any) => {
            if (Array.isArray(entry) && entry[1] && typeof entry[1] === "string") {
              const clean = this.normalizeServerUrl(entry[1]);
              if (clean.startsWith("http") && !streams.includes(clean)) streams.push(clean);
            }
          });
        }
      } catch {}
    }

    const standardStreams = this.extractEmbedsAndStreamsFromHtml($, html, baseUrl);
    standardStreams.forEach((st) => {
      const clean = this.normalizeServerUrl(st);
      if (clean.startsWith("http") && !streams.includes(clean)) streams.push(clean);
    });

    // 4. WordPress theme: botones `button.iframe_code[data-src]` y `#iframeHolder[data-default-src]`
    const wpServers = this.extractWordPressServers($);
    for (const raw of wpServers) {
      const clean = this.normalizeServerUrl(raw);
      if (clean.startsWith("http") && !streams.includes(clean)) streams.push(clean);
    }

    return streams;
  }

  private extractAnimeflvEpisodes($: cheerio.CheerioAPI, html: string, urlObj: URL): ExtractedEpisode[] {
    const extractedEpisodes: ExtractedEpisode[] = [];

    // 1. WordPress (animeflv.or.at / custom themes) JSON embedded episodes
    const epDataElement = $(".animeflv-episodes-data");
    if (epDataElement.length > 0) {
      try {
        const epData = JSON.parse(epDataElement.text().trim() || "[]");
        if (Array.isArray(epData)) {
          const sorted = [...epData].sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
          sorted.forEach((ep) => {
            if (ep.permalink) {
              extractedEpisodes.push({
                number: Number(ep.number) || 1,
                title: `Episodio ${ep.number || 1}`,
                url: ep.permalink,
              });
            }
          });
        }
      } catch {}
    }

    if (extractedEpisodes.length > 0) {
      return extractedEpisodes;
    }

    const scriptTexts: string[] = [];
    $("script").each((_, el) => {
      const content = $(el).html() || "";
      if (content) scriptTexts.push(content);
    });
    const allScripts = scriptTexts.join("\n");

    const animeInfoMatch = allScripts.match(/var\s+anime_info\s*=\s*(\[[^;]+\]);/);
    const episodesMatch = allScripts.match(/var\s+episodes\s*=\s*(\[[^;]+\]);/);

    if (episodesMatch) {
      try {
        const epData = JSON.parse(episodesMatch[1]);
        let animeSlug = "";
        if (animeInfoMatch) {
          try {
            const info = JSON.parse(animeInfoMatch[1]);
            // anime_info = [id, titulo, slug]: el slug es el índice 2 (no el título)
            animeSlug = String(info[2] || "").trim();
          } catch {}
        }
        if (!animeSlug) {
          const seg = urlObj.pathname.split("/").filter(Boolean).pop() || "anime";
          animeSlug = decodeURIComponent(seg).toLowerCase().replace(/\s+/g, "-");
        } else {
          animeSlug = animeSlug.toLowerCase().replace(/\s+/g, "-");
        }

        if (Array.isArray(epData)) {
          const sorted = [...epData].sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0));
          sorted.forEach((ep) => {
            const epNum = ep[0];
            const epUrl = `https://${urlObj.host}/ver/${encodeURIComponent(`${animeSlug}-${epNum}`).replace(/%2D/g, "-")}`;
            extractedEpisodes.push({
              number: Number(epNum) || 1,
              title: `Episodio ${epNum}`,
              url: epUrl,
            });
          });
        }
      } catch {}
    }

    if (extractedEpisodes.length === 0) {
      $("ul.episodes-list li a, .ListCaps a, ul.ListCaps li a, .capitulos-list a, .episode-list a").each((idx, el) => {
        const rawText = $(el).text().trim() || $(el).attr("title") || `Episodio ${idx + 1}`;
        let href = $(el).attr("href") || "";
        if (href && !href.startsWith("http")) {
          try {
            href = new URL(href, `https://${urlObj.host}`).toString();
          } catch {}
        }
        if (href && !extractedEpisodes.some((e) => e.url === href)) {
          const numMatch = rawText.match(/\b(?:episodio|capitulo|ep|cap)?\s*(\d+(?:\.\d+)?)\b/i) || href.match(/[-_](\d+(?:\.\d+)?)(?:\/|$|\.html)/i);
          const num = numMatch ? parseFloat(numMatch[1]) : idx + 1;
          extractedEpisodes.push({
            number: num,
            title: rawText.replace(/\s+/g, " "),
            url: href,
          });
        }
      });
    }

    return extractedEpisodes;
  }

  private extractAnimeflvCard($: cheerio.CheerioAPI, card: cheerio.Element, baseUrl: string): ExtractedCatalogItem | null {
    const animeAnchor = $(card).find("a.thumbnail-link, a[href*='/anime/'], h2.entry-title a, h3 a, h2 a, a[href]").first();
    if (animeAnchor.length === 0) return null;

    const href = (animeAnchor.attr("href") || "").trim();
    if (!href || href === "#" || href.startsWith("javascript:")) return null;

    let fullUrl = href;
    if (!fullUrl.startsWith("http")) {
      try {
        fullUrl = new URL(href, baseUrl).toString();
      } catch {
        return null;
      }
    }

    const img = $(card).find("img.anime-image, img").first();
    let imgUrl: string | null = null;
    if (img.length > 0) {
      const imgSrc =
        img.attr("data-src") ||
        img.attr("data-cfsrc") ||
        img.attr("data-lazy-src") ||
        img.attr("data-original") ||
        img.attr("srcset") ||
        img.attr("src") ||
        "";
      if (imgSrc) {
        const firstSrc = imgSrc.split(/\s+/)[0];
        try {
          imgUrl = new URL(firstSrc, baseUrl).toString();
        } catch {
          imgUrl = firstSrc.startsWith("//") ? `https:${firstSrc}` : firstSrc;
        }
      }
    }

    let cardTitle = "";
    const heading = $(card).find("h1, h2, h3, h4, h5, strong, .entry-title, .Title, .title").first();
    if (heading.length > 0 && heading.text().trim().length > 1) {
      cardTitle = heading.text().trim();
    }
    if (!cardTitle && img.length > 0 && img.attr("alt")) {
      cardTitle = img.attr("alt")!.trim();
    }
    if (!cardTitle) {
      cardTitle = animeAnchor.text().trim() || animeAnchor.attr("title") || "";
    }

    const lowerTitle = cardTitle.toLowerCase();
    if (
      !cardTitle ||
      !fullUrl ||
      ["inicio", "home", "directorio anime", "dmca", "contacto", "login", "terms of service", "skip to content"].some((b) => lowerTitle.includes(b))
    ) {
      return null;
    }

    return {
      title: cleanQueryTitle(cardTitle),
      url: fullUrl,
      image_url: imgUrl,
      kind: "anime",
    };
  }

  private async fallbackSearch(query: string): Promise<UniversalAnalysisResult> {
    const cleaned = cleanQueryTitle(query);
    const enriched = await enrichUniversalMetadata(cleaned, "anime");
    return {
      page_type: "detail",
      content_type: "anime",
      title: enriched.title || cleaned,
      description: enriched.description || `Búsqueda para '${query}'`,
      poster_url: enriched.poster_url || null,
      banner_url: enriched.banner_url || null,
      rating: enriched.rating || 8.0,
      year: enriched.year || 2024,
      status: enriched.status || "Finalizado",
      genres: enriched.genres || ["Anime"],
      episodes: [{ number: 1, title: "Episodio 1", url: `https://www3.animeflv.net/browse?q=${encodeURIComponent(cleaned)}` }],
      catalog_items: [],
    };
  }
}
