import * as cheerio from "cheerio";
import { BaseScraperAdapter, COMMON_HEADERS } from "../BaseAdapter";
import { UniversalAnalysisResult, ContentKind, ExtractedEpisode, ExtractedCatalogItem } from "../../types";
import { EmbedResolvers } from "../../resolvers";
import { VimeosResolver } from "../vimeosResolver";
import { MediaValidator } from "../../validator";

const BASE_URL = "https://www.cinecalidad.am";

/**
 * Adaptador para cinecalidad.am (y espejos .mx/.im)
 *
 * - Catálogo/Búsqueda: cards `article.item.movies`; búsqueda vía /?s=query.
 *   Imágenes lazy-load: URL real en `data-src` (TMDb), `src` es placeholder base64.
 *   Los enlaces con ancla `#aHR0c...` (Base64) son publicidad y se excluyen del catálogo.
 * - Detalles: og:title/og:description; sin og:image → poster desde img[data-src] TMDb.
 * - Episodios: `ul.episodios li` con `.numerando` ("S1-E1") y enlaces
 *   `/ver-el-episodio/{slug}-{S}x{E}/`.
   * - Video: el DOM del reproductor cambió; ya no basta con las anclas `#aHR0c...`
   *   ni con `li[data-option]`. Ahora `extractStream()` combina varias fuentes en
   *   orden de robustez:
   *   1. Hash-links `#aHR0c...` decodificados en Base64 (técnica legacy, salta dooplay JS).
   *   2. Servidores dooplay `li[data-post]` → POST a `wp-admin/admin-ajax.php`
   *      (`action=doo_player_ajax`) que devuelve el `embed_url` real del iframe.
   *   3. Iframes del reproductor (`src`/`data-src`/`data-player`/`data-url`).
   *   4. URLs de servidores soportados escaneadas por regex (Fembed, Mega, Uqload, etc.).
   *   5. `li[data-option]` legacy.
   *   6. Fallback genérico de BaseScraperAdapter (iframes/scripts).
   *   Cada candidato se resuelve con EmbedResolvers y se valida con MediaValidator.
   * - Vimeos.net: resuelto con el módulo compartido VimeosResolver (MP4 directo vía
   *   el form POST `op=download_orig`; verificado 2026-08-22: POST con el hash del
   *   HTML → enlace `s{N}.vimeos.net/v/.../*.mp4`, responde 206 video/mp4).
 */
export class CinecalidadAdapter extends BaseScraperAdapter {
  readonly id = "cinecalidad";
  readonly name = "Cinecalidad";
  readonly supportedDomains = ["cinecalidad.am", "www.cinecalidad.am", "cinecalidad.mx", "cinecalidad.im"];

  canHandle(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.includes("cinecalidad");
  }

  /**
   * Búsqueda de películas y series (?s=query). Usa la misma estructura de cards del Home.
   */
  public async search(query: string): Promise<ExtractedCatalogItem[]> {
    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query.trim())}`;
    const html = await this.fetchHtml(searchUrl, 10000);
    if (!html) return [];
    return this.extractCatalogItems(html);
  }

  /**
   * Extrae items del Home o resultados de búsqueda.
   * Imagen: prioriza data-src (TMDb) sobre src (placeholder base64).
   * Excluye las tarjetas publicitarias (enlaces con ancla #hash o dominios externos).
   */
  public extractCatalogItems(html: string): ExtractedCatalogItem[] {
    const $ = cheerio.load(html);
    const items: ExtractedCatalogItem[] = [];
    const seen = new Set<string>();

    const isFicha = (u: string) => /\/(?:ver-)?(?:pelicula|serie)\//i.test(u);

    const buildItem = ($el: any): void => {
      const isAnchor = $el.is("a");
      const $link = isAnchor
        ? $el
        : $el.find('a[href*="/ver-pelicula/"], a[href*="/ver-serie/"], a[href*="/pelicula/"], a[href*="/serie/"]').first();
      const href = ($link.attr("href") || "").trim();
      if (!href) return;
      const url = this.resolveRelativeUrl(href, BASE_URL);
      if (!url || seen.has(url) || !isFicha(url)) return;
      seen.add(url);

      const $img = $el.find("img").first();
      const dataSrc = ($img.attr("data-src") || "").trim();
      const src = ($img.attr("src") || "").trim();
      const rawImg = /^https?:\/\//i.test(dataSrc)
        ? dataSrc
        : /^https?:\/\//i.test(src)
          ? src
          : "";
      const image_url = rawImg ? this.resolveRelativeUrl(rawImg, BASE_URL) : null;

      const title =
        $el.find(".in_title").first().text().trim() ||
        ($img.attr("alt") || "").trim() ||
        this.titleFromUrl(url);

      let year: number | null = null;
      $el.find(".home_post_content p").each((_: any, p: any) => {
        if (year !== null) return;
        const t = $(p).text().trim();
        if (/^(19|20)\d{2}$/.test(t)) year = parseInt(t, 10);
      });

      const ratingText = $el.find(".rating").first().text().trim().replace(",", ".");
      const ratingVal = parseFloat(ratingText);
      const rating = isNaN(ratingVal) ? null : ratingVal;

      const genres: string[] = [];
      $el.find(".home_post_cat a").each((_: any, g: any) => {
        const genre = $(g).text().trim();
        if (genre && !genres.includes(genre)) genres.push(genre);
      });

      items.push({
        title,
        url,
        image_url,
        kind: this.kindFromUrl(url),
        year,
        rating,
        genres,
      });
    };

    $("article.item, article").each((_, el) => buildItem($(el)));
    if (items.length === 0) {
      $("a[href*='/ver-pelicula/'], a[href*='/ver-serie/'], a[href*='/pelicula/'], a[href*='/serie/']").each((_, el) => buildItem($(el)));
    }

    return items;
  }

  /**
   * Metadatos de una página de detalle: OpenGraph + poster img[data-src].
   * Nota verificada: el detalle NO expone og:image; el poster vive en un <img data-src> TMDb.
   */
  public extractMetadata(html: string, url: string): {
    title: string;
    description: string;
    poster_url?: string;
    banner_url?: string;
    rating: number;
    year: number;
    original_title?: string;
    tmdb_id?: number;
    genres: string[];
    duration?: string | null;
    content_type: ContentKind;
  } {
    const $ = cheerio.load(html);

    const ogTitle = $('meta[property="og:title"]').attr("content") || "";
    const h1Title = $("h1")
      .filter((_, el) => {
        const t = $(el).text().trim();
        return t.length > 0 && !/^cinecalidad$/i.test(t);
      })
      .first()
      .text()
      .trim();

    const title =
      this.cleanTitle(ogTitle) ||
      h1Title ||
      "Contenido Cinecalidad";

    const description =
      $('meta[property="og:description"]').attr("content") ||
      $(".custom_synop").first().text().trim() ||
      "";

    const dataSrcPoster = $("img[data-src]")
      .map((_, el) => ($(el).attr("data-src") || "").trim())
      .get()
      .find((s) => /^https?:\/\//i.test(s));
    const srcPoster = $("img[src]")
      .map((_, el) => ($(el).attr("src") || "").trim())
      .get()
      .find((s) => /^https?:\/\//i.test(s));
    const ogImage = $('meta[property="og:image"]').attr("content");
    const posterRaw = dataSrcPoster || ogImage || srcPoster || "";
    const poster_url = posterRaw ? this.resolveRelativeUrl(posterRaw, url) : undefined;

    const genres: string[] = [];
    $('a[href*="/genero-de-la-pelicula/"]').each((_, g) => {
      const genre = $(g).text().trim();
      if (genre && !genres.includes(genre)) genres.push(genre);
    });

    const ratingMatch =
      html.match(/class="rating">\s*([\d.,]+)\s*</i) ||
      html.match(/IMDb[\s:]*([\d.]+)/i);
    const rating = ratingMatch ? parseFloat(ratingMatch[1].replace(",", ".")) : 0;

    const yearMatch =
      html.match(/A\u00f1o[\s:]*((?:19|20)\d{2})/i) ||
      title.match(/((?:19|20)\d{2})/) ||
      description.match(/((?:19|20)\d{2})/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : 0;

    const originalTitle = $("span")
      .filter((_, el) => /Títulos:/i.test($(el).text()))
      .first()
      .text()
      .replace(/^\s*Títulos:\s*/i, "")
      .trim();
    const tmdbMatch = html.match(/videoapp\.zip\/e\/(?:movie|tv)\/(\d+)/i);

    const durationMatch = html.match(/(\d+\s*min(?:utos)?)/i);

    return {
      title,
      description,
      poster_url,
      banner_url: poster_url,
      rating,
      year,
      original_title: originalTitle || undefined,
      tmdb_id: tmdbMatch ? parseInt(tmdbMatch[1], 10) : undefined,
      genres,
      duration: durationMatch ? durationMatch[1] : null,
      content_type: this.kindFromUrl(url),
    };
  }

  /**
   * Episodios de una serie: ul.episodios li con .numerando ("S1-E1") y
   * .episodiotitle a[href*="/ver-el-episodio/"]. Número desde numerando o URL SxE.
   */
  public extractEpisodes(html: string, baseUrl: string): ExtractedEpisode[] {
    const $ = cheerio.load(html);
    const episodes: ExtractedEpisode[] = [];
    const seen = new Set<string>();

    $("ul.episodios li").each((_, li) => {
      const $li = $(li);
      const $a = $li.find('a[href*="/ver-el-episodio/"]').first();
      const href = $a.attr("href");
      if (!href || seen.has(href)) return;
      seen.add(href);

      const fullUrl = this.resolveRelativeUrl(href, baseUrl);
      const numerando = $li.find(".numerando").first().text().trim();
      const numMatch = numerando.match(/E\s*(\d+)/i) || fullUrl.match(/-(\d+)x(\d+)\/?$/);
      const number = numMatch ? parseInt(numMatch[numMatch.length - 1], 10) : episodes.length + 1;
      const linkText = $a.text().replace(/\s+/g, " ").trim();

      episodes.push({
        number,
        title: linkText || `Episodio ${number}`,
        url: fullUrl,
        source_type: this.id,
        server_name: "Cinecalidad",
      });
    });

    return episodes.sort((a, b) => a.number - b.number);
  }

  /**
   * Técnica crítica: extrae la parte posterior al "#" de los href tipo "#aHR0c..."
   * y la decodifica en Base64 para obtener el enlace directo al reproductor,
   * saltándose la inyección JS de #dooplay_player_response.
   */
  public decodeHashLinks(html: string): string[] {
    const links: string[] = [];
    const regex = /#([A-Za-z0-9+/=]{16,})/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null) {
      try {
        const decoded = Buffer.from(match[1], "base64").toString("utf-8").trim();
        if (/^https?:\/\//i.test(decoded) && !links.includes(decoded)) {
          links.push(decoded);
        }
      } catch {}
    }
    return links;
  }

  /**
   * Reproductores dooplay: li[data-option] con URLs directas (excluye trailers de YouTube).
   */
  private extractPlayerOptions(html: string, baseUrl: string): string[] {
    const $ = cheerio.load(html);
    const options: string[] = [];
    $("[data-option]").each((_, el) => {
      const val = ($(el).attr("data-option") || "").trim();
      if (!val) return;
      let candidate = this.resolveRelativeUrl(val, baseUrl);
      try {
        const encoded = new URL(candidate).searchParams.get("zopass");
        if (encoded) candidate = Buffer.from(encoded, "base64").toString("utf8").trim();
      } catch {}
      if (!/^https?:\/\//i.test(candidate) || /youtube\.com|youtu\.be/i.test(candidate)) return;
      if (!options.includes(candidate)) options.push(candidate);
    });
    return options;
  }

  /**
   * Embeds del reproductor: iframes del DOM (incluye `data-src`/`data-player`,
   * que el DOM actual de dooplay usa en lugar de `src` directo).
   */
  private extractIframeEmbeds(html: string, baseUrl: string): string[] {
    const $ = cheerio.load(html);
    const out: string[] = [];
    $("iframe").each((_, el) => {
      const src =
        $(el).attr("src") ||
        $(el).attr("data-src") ||
        $(el).attr("data-player") ||
        $(el).attr("data-url") ||
        $(el).attr("data-lazy-src") ||
        "";
      if (!src) return;
      const resolved = this.resolveRelativeUrl(src, baseUrl);
      if (
        /^https?:\/\//i.test(resolved) &&
        !/youtube\.com|youtu\.be/i.test(resolved) &&
        !this.isJunkUrl(resolved) &&
        !out.includes(resolved)
      ) {
        out.push(resolved);
      }
    });
    return out;
  }

  /**
   * Servidores dooplay: cada `li[data-post][data-nume][data-type]` es un servidor
   * cuyo `embed_url` (Fembed, Mega, Uqload, etc.) se obtiene vía POST al AJAX de
   * dooplay (admin-ajax.php?action=doo_player_ajax). Salta la inyección JS que el
   * DOM actual ya no expone en el HTML estático.
   */
  private async extractDooplayServerEmbeds(pageUrl: string, html: string): Promise<string[]> {
    const $ = cheerio.load(html);
    const servers: Array<{ post: string; type: string; nume: string }> = [];
    $("li[data-post]").each((_, el) => {
      const $li = $(el);
      const post = ($li.attr("data-post") || "").trim();
      if (!post) return;
      const type = ($li.attr("data-type") || (this.kindFromUrl(pageUrl) === "series" ? "tv" : "movie")).trim();
      const nume = ($li.attr("data-nume") || "1").trim();
      servers.push({ post, type, nume });
    });
    if (servers.length === 0) return [];

    const nonce = ($("[data-nonce]").first().attr("data-nonce") || "").trim();
    const ajaxUrl = this.resolveRelativeUrl("/wp-admin/admin-ajax.php", pageUrl);
    const embeds: string[] = [];
    for (const s of servers.slice(0, 3)) {
      try {
          const body =
            `action=doo_player_ajax&post=${encodeURIComponent(s.post)}` +
            `&type=${encodeURIComponent(s.type)}&nume=${encodeURIComponent(s.nume)}` +
            (nonce ? `&nonce=${encodeURIComponent(nonce)}` : "");
          const res = await fetch(ajaxUrl, {
            method: "POST",
            headers: {
              "User-Agent": COMMON_HEADERS["User-Agent"],
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest",
              Referer: pageUrl,
            },
            body,
          });
          if (!res.ok) continue;
          const text = await res.text();
          let embed = "";
          try {
            const json = JSON.parse(text);
            embed = json.embed_url || json.embed || json.url || "";
          } catch {
            const m = text.match(/https?:\/\/[^\s"'<>\\]+/i);
            if (m) embed = m[0];
          }
          embed = (embed || "").trim();
          if (/^https?:\/\//i.test(embed) && !this.isJunkUrl(embed) && !embeds.includes(embed)) {
            embeds.push(embed);
          }
      } catch {}
    }
    return embeds;
  }

  /**
   * Scan directo del HTML por URLs de servidores soportados (Fembed, Mega, Uqload,
   * MP4Upload, Dood, etc.) que el DOM actual embebe en atributos/data-URLs.
   */
  private extractKnownServerUrls(html: string): string[] {
    const out: string[] = [];
    const regex =
      /https?:\/\/(?:www\.)?(?:[a-z0-9.-]+\.)?(?:fembed[0-9]*\.[a-z]+|feurl\.com|fembed\.flix?|mega\.nz|uqload\.[a-z]+|mp4upload\.com|dood\.[a-z]+|doodstream\.[a-z]+|ds2play\.com|d000d\.com|streamwish\.[a-z]+|vidmoly\.[a-z]+|upstream\.[a-z]+|gamovideo\.[a-z]+|netu\.[a-z]+|streamlare\.[a-z]+|fastre\.[a-z]+|ok\.ru|vimeos\.[a-z]+|byselapuix\.com|zilla-networks\.com|yourupload\.com|streamtape\.com)\/[^\s"'<>\\]+/gi;
    const matches = html.match(regex);
    if (matches) {
      for (const m of matches) {
        const clean = m.replace(/\\/g, "").replace(/["']/g, "").trim();
        if (/^https?:\/\//i.test(clean) && !this.isJunkUrl(clean) && !out.includes(clean)) {
          out.push(clean);
        }
      }
    }
    return out;
  }

  public async analyze(
    input: string,
    explicitType?: "auto" | "catalog" | "detail" | "stream"
  ): Promise<UniversalAnalysisResult> {
    const cleanInput = input.trim();

    // Término de búsqueda en lugar de URL
    if (!/^https?:\/\//i.test(cleanInput)) {
      const catalogItems = await this.search(cleanInput);
      return {
        page_type: "catalog",
        content_type: "movie",
        title: `Búsqueda "${cleanInput}" - Cinecalidad`,
        description: `Resultados para "${cleanInput}" (${catalogItems.length} títulos)`,
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: 0,
        status: "Publicado",
        genres: [],
        source_domain: "cinecalidad.am",
        episodes: [],
        catalog_items: catalogItems,
      };
    }

    const path = new URL(cleanInput).pathname.toLowerCase();

    // Modo catálogo: Home, paginación (/page/N/) o petición explícita
    const isCatalog =
      explicitType === "catalog" || path === "/" || path === "" || /^\/page\/\d+/.test(path);
    if (isCatalog) {
      // Fetch de la URL REAL recibida (con su página); fallback al home.
      let html = await this.fetchHtml(cleanInput, 10000);
      if (!html && path !== "/" && path !== "") {
        html = await this.fetchHtml(`${BASE_URL}/`, 10000);
      }
      if (!html) throw new Error(`FETCH_FAILED: ${cleanInput}`);
      const catalogItems = this.extractCatalogItems(html);
      return {
        page_type: "catalog",
        content_type: "movie",
        title: "Catálogo de Películas y Series - Cinecalidad",
        description: `Catálogo completo en Cinecalidad (${catalogItems.length} títulos)`,
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: 0,
        status: "Publicado",
        genres: [],
        source_domain: "cinecalidad.am",
        episodes: [],
        catalog_items: catalogItems,
      };
    }

    // Modo detalle
    const contentType = this.kindFromUrl(cleanInput);
    const html = await this.fetchHtml(cleanInput, 10000);
    if (!html) {
      return {
        page_type: "detail",
        content_type: contentType,
        title: "Contenido Cinecalidad",
        description: "No se pudo cargar la página",
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: 0,
        status: "Desconocido",
        genres: [],
        source_domain: "cinecalidad.am",
        episodes: [],
        catalog_items: [],
      };
    }

    const metadata = this.extractMetadata(html, cleanInput);
    let episodes = contentType === "series" ? this.extractEpisodes(html, cleanInput) : [];

    // Las películas no tienen listado de episodios en dooplay: se sintetiza un
    // episodio único apuntando a la propia página de detalle para habilitar JIT.
    if (episodes.length === 0 && contentType === "movie") {
      episodes = [
        {
          number: 1,
          title: metadata.title || "Película",
          url: cleanInput,
          source_type: this.id,
          server_name: "Cinecalidad",
        },
      ];
    }

    let detectedStreams: string[] | undefined;
    if (!explicitType || explicitType === "stream" || explicitType === "auto") {
      try {
        detectedStreams = (await this.extractStream(cleanInput)).all_available_streams;
      } catch {}
    }

    return {
      page_type: "detail",
      content_type: metadata.content_type,
      title: metadata.title,
      original_title: metadata.original_title,
      tmdb_id: metadata.tmdb_id,
      description: metadata.description,
      poster_url: metadata.poster_url || null,
      banner_url: metadata.banner_url || null,
      rating: metadata.rating,
      year: metadata.year,
      status: "Publicado",
      genres: metadata.genres,
      duration: metadata.duration || null,
      source_domain: "cinecalidad.am",
      detected_streams: detectedStreams,
      episodes,
      catalog_items: [],
      raw_metadata: {
        og: {
          title: metadata.title,
          description: metadata.description,
          image: metadata.poster_url || "",
        },
      },
    };
  }

  /**
   * Extrae streams de una página de película/episodio combinando varias fuentes
   * ordenadas por robustez (ver documentación de clase). Cada candidato se resuelve
   * con EmbedResolvers y se valida con MediaValidator.
   */
  public async extractStream(targetUrl: string): Promise<{
    stream_url: string;
    all_available_streams: string[];
    title?: string;
  }> {
    const cleanUrl = targetUrl.trim();
    const html = await this.fetchHtml(cleanUrl, 12000);
    if (!html) {
      return { stream_url: cleanUrl, all_available_streams: [cleanUrl] };
    }

    const $ = cheerio.load(html);
    const title = this.cleanTitle($('meta[property="og:title"]').attr("content") || "") || undefined;

    const hashLinks = this.decodeHashLinks(html);
    const dooplayEmbeds = await this.extractDooplayServerEmbeds(cleanUrl, html);
    const iframeEmbeds = this.extractIframeEmbeds(html, cleanUrl);
    const serverUrls = this.extractKnownServerUrls(html);
    const playerOptions = this.extractPlayerOptions(html, cleanUrl);

    const rawCandidates: string[] = [];
    [...hashLinks, ...dooplayEmbeds, ...iframeEmbeds, ...serverUrls, ...playerOptions]
      .filter((u) => u && /^https?:\/\//i.test(u) && !this.isJunkUrl(u))
      .forEach((u) => {
        if (!rawCandidates.includes(u)) rawCandidates.push(u);
      });
    // Vimeos `/d/{id}_h` es una página de descarga HTML: sustituir por MP4 directo
    // (y descartar los que fallen, no son reproducibles).
    const candidates = await VimeosResolver.fixVimeosStreams(rawCandidates);

    if (candidates.length === 0) {
      const generic = await super.extractStream(cleanUrl);
      const cleanStreams = generic.all_available_streams.filter((u) => !this.isJunkUrl(u));
      const genericStreamUrl = cleanStreams.includes(generic.stream_url)
        ? generic.stream_url
        : cleanStreams[0] || cleanUrl;
      return {
        stream_url: genericStreamUrl,
        all_available_streams: cleanStreams.length > 0 ? cleanStreams : [cleanUrl],
        title,
      };
    }

    const resolutions = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          return { candidate, resolved: await EmbedResolvers.resolve(candidate) };
        } catch {
          return { candidate, resolved: "" };
        }
      })
    );

    const rawResolvedList: string[] = [];
    for (const { candidate, resolved } of resolutions) {
      if (resolved && !rawResolvedList.includes(resolved)) rawResolvedList.push(resolved);
      if (!rawResolvedList.includes(candidate)) rawResolvedList.push(candidate);
    }

    // EmbedResolvers puede devolver el embed de vimeos sin resolver: re-aplicar
    // la conversión a MP4 directo sobre la lista resuelta.
    const resolvedList = await VimeosResolver.fixVimeosStreams(rawResolvedList);

    const validated = await MediaValidator.validateUrls(resolvedList);
    const usableValidated = validated.filter((u) => !this.isJunkUrl(u));
    const directMedia = usableValidated.filter((u) => /\.(m3u8|mp4|webm)(\?|$)/i.test(u));
    const validatedEmbeds = usableValidated.filter((u) => !directMedia.includes(u));

    let finalStreams: string[];
    if (directMedia.length > 0) {
      finalStreams = [
        ...directMedia,
        ...validatedEmbeds,
        ...resolvedList.filter((u) => !usableValidated.includes(u) && !this.isJunkUrl(u)),
      ];
    } else if (validatedEmbeds.length > 0) {
      finalStreams = [
        ...validatedEmbeds,
        ...resolvedList.filter((u) => !usableValidated.includes(u) && !this.isJunkUrl(u)),
      ];
    } else {
      finalStreams = resolvedList.filter((u) => !this.isJunkUrl(u));
    }
    finalStreams = Array.from(new Set(finalStreams)).filter((u) => /^https?:\/\//i.test(u));

    return {
      stream_url: finalStreams[0] || cleanUrl,
      all_available_streams: finalStreams.length > 0 ? finalStreams : [cleanUrl],
      title,
    };
  }

  private kindFromUrl(url: string): ContentKind {
    return /\/ver-(?:serie|el-episodio)\//i.test(url) ? "series" : "movie";
  }

  private static readonly DEAD_OR_BLOCKED_HOST_PATTERNS = [
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

  /**
   * Filtra URLs basura que el fallback genérico puede arrastrar:
   * imágenes TMDb (lazy-load data-src), banners publicitarios, estáticos y hosts muertos.
   */
  private isJunkUrl(url: string): boolean {
    return (
      /image\.tmdb\.org|adsanalytics\.org|\.(jpe?g|png|gif|webp|svg|css|js)(\?|$)/i.test(url) ||
      CinecalidadAdapter.DEAD_OR_BLOCKED_HOST_PATTERNS.some((p) => p.test(url))
    );
  }

  private cleanTitle(raw: string): string {
    return raw
      .replace(/\s*[-–—|]\s*Cinecalidad.*$/i, "")
      .replace(/^ver\b(?:\s+online)?(?:\s+gratis)?\s*/i, "")
      .trim();
  }

  private titleFromUrl(url: string): string {
    const match = url.match(/\/ver-(?:pelicula|serie|el-episodio)\/([^/]+)/);
    if (!match) return "Contenido Cinecalidad";
    return match[1]
      .replace(/-\d+x\d+\/?$/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase())
      .trim();
  }
}
