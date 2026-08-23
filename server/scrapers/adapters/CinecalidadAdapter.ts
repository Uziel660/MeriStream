import * as cheerio from "cheerio";
import { BaseScraperAdapter } from "../BaseAdapter";
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
 * - Video: técnica de hash en URL. Anclas `#aHR0c...` decodificadas en Base64 revelan
 *   el enlace directo al reproductor (se evita la ejecución de JS que inyecta
 *   #dooplay_player_response). Los reproductores también exponen URLs directas en
 *   `li[data-option]` (vimeos.net, voe.sx, doodstream, goodstream). Todo se resuelve
 *   con EmbedResolvers.resolve y se valida con MediaValidator.
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

    $("article.item").each((_, el) => {
      const $art = $(el);
      const $link = $art.find('a[href*="/ver-pelicula/"], a[href*="/ver-serie/"]').first();
      const href = $link.attr("href");
      if (!href || !/\/ver-(?:pelicula|serie)\//i.test(href)) return;

      const url = this.resolveRelativeUrl(href, BASE_URL);
      if (seen.has(url)) return;
      seen.add(url);

      const $img = $art.find("img").first();
      const dataSrc = ($img.attr("data-src") || "").trim();
      const src = ($img.attr("src") || "").trim();
      const rawImg = /^https?:\/\//i.test(dataSrc)
        ? dataSrc
        : /^https?:\/\//i.test(src)
          ? src
          : "";
      const image_url = rawImg ? this.resolveRelativeUrl(rawImg, BASE_URL) : null;

      const title =
        $art.find(".in_title").first().text().trim() ||
        ($img.attr("alt") || "").trim() ||
        this.titleFromUrl(url);

      let year: number | null = null;
      $art.find(".home_post_content p").each((_, p) => {
        if (year !== null) return;
        const t = $(p).text().trim();
        if (/^(19|20)\d{2}$/.test(t)) year = parseInt(t, 10);
      });

      const ratingText = $art.find(".rating").first().text().trim().replace(",", ".");
      const ratingVal = parseFloat(ratingText);
      const rating = isNaN(ratingVal) ? null : ratingVal;

      const genres: string[] = [];
      $art.find(".home_post_cat a").each((_, g) => {
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
    });

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
      html.match(/A\u00f1o[\s:]*(\d{4})/i) ||
      title.match(/(19|20)\d{2}/) ||
      description.match(/(19|20)\d{2}/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();

    const durationMatch = html.match(/(\d+\s*min(?:utos)?)/i);

    return {
      title,
      description,
      poster_url,
      banner_url: poster_url,
      rating,
      year,
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
  private extractPlayerOptions(html: string): string[] {
    const $ = cheerio.load(html);
    const options: string[] = [];
    $("[data-option]").each((_, el) => {
      const val = ($(el).attr("data-option") || "").trim();
      if (!val) return;
      if (/youtube\.com|youtu\.be/i.test(val)) return;
      if (/^https?:\/\//i.test(val) && !options.includes(val)) options.push(val);
    });
    return options;
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
        year: new Date().getFullYear(),
        status: "Publicado",
        genres: [],
        source_domain: "cinecalidad.am",
        episodes: [],
        catalog_items: catalogItems,
      };
    }

    const path = new URL(cleanInput).pathname.toLowerCase();

    // Modo catálogo: Home o petición explícita
    if (explicitType === "catalog" || path === "/" || path === "") {
      const html = await this.fetchHtml(`${BASE_URL}/`, 10000);
      const catalogItems = html ? this.extractCatalogItems(html) : [];
      return {
        page_type: "catalog",
        content_type: "movie",
        title: "Catálogo de Películas y Series - Cinecalidad",
        description: `Catálogo completo en Cinecalidad (${catalogItems.length} títulos)`,
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: new Date().getFullYear(),
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
        year: new Date().getFullYear(),
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
   * Extrae streams de una página de película/episodio:
   * 1. Hash-links "#aHR0c..." decodificados en Base64 (técnica principal, salta dooplay JS).
   * 2. li[data-option] con URLs directas de reproductores.
   * 3. Fallback genérico de BaseScraperAdapter (iframes/scripts).
   * Cada candidato se resuelve con EmbedResolvers y se valida con MediaValidator.
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
    const playerOptions = this.extractPlayerOptions(html);

    const rawCandidates: string[] = [];
    [...hashLinks, ...playerOptions]
      .filter((u) => !this.isJunkUrl(u))
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
