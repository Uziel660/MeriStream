import * as cheerio from "cheerio";
import { BaseScraperAdapter } from "../BaseAdapter";
import { UniversalAnalysisResult, ContentKind, ExtractedEpisode, ExtractedCatalogItem } from "../../types";
import { EmbedResolvers } from "../../resolvers";
import { MediaValidator } from "../../validator";

const BASE_URL = "https://tubepelis.com";

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

const isDeadOrBlocked = (url: string) =>
  DEAD_OR_BLOCKED_HOST_PATTERNS.some((p) => p.test(url));

/**
 * Adaptador para tubepelis.com (películas)
 *
 * - Catálogo/Búsqueda: enlaces `a[href*="/pelicula/{id}/{slug}.html"]` (búsqueda en /buscar/?q=)
 * - Detalles: metadatos OpenGraph + JSON-LD Movie Schema
 * - Video (crítico): los iframes apuntan al proxy interno `reproductor.php?v=...`
 *   donde `v` es Base64 con URL-encoding (ej. `%3D` = `=`). Al decodificar se obtiene
 *   el embed final (voe/doodstream-clones). Se resuelve con EmbedResolvers y se
 *   valida con MediaValidator.
 */
export class TubePelisAdapter extends BaseScraperAdapter {
  readonly id = "tubepelis";
  readonly name = "TubePelis (Películas)";
  readonly supportedDomains = ["tubepelis.com", "www.tubepelis.com"];

  canHandle(url: string): boolean {
    return url.toLowerCase().includes("tubepelis.com");
  }

  /**
   * Búsqueda de películas (/buscar/?q=...)
   */
  public async search(query: string): Promise<ExtractedCatalogItem[]> {
    const searchUrl = `${BASE_URL}/buscar/?q=${encodeURIComponent(query.trim())}`;
    const html = await this.fetchHtml(searchUrl, 10000);
    if (!html) return [];
    return this.extractCatalogItems(html);
  }

  /**
   * Extrae items del catálogo (Home, búsqueda o categorías).
   * Las cards reales no usan clase `.item`/`.pelicula`; el anclaje confiable es
   * `a[href*="/pelicula/{id}/{slug}.html"]`.
   */
  private extractCatalogItems(html: string): ExtractedCatalogItem[] {
    const $ = cheerio.load(html);
    const items: ExtractedCatalogItem[] = [];
    const byUrl = new Map<string, ExtractedCatalogItem>();

    // Pasada 1: recolectar URLs únicas /pelicula/{id}/{slug}.html
    $('a[href*="/pelicula/"]').each((_, el) => {
      const href = $(el).attr("href") || "";
      const match = href.match(/\/pelicula\/(\d+)\/([^/]+)\.html/i);
      if (!match || byUrl.has(match[0])) return;

      const movieId = match[1];
      const rawImg =
        $(el).closest("div").find("img").first().attr("src") ||
        $(el).closest("div").find("img").first().attr("data-src") ||
        "";
      const imageUrl = rawImg && !rawImg.includes("placeholder")
        ? this.resolveRelativeUrl(rawImg, BASE_URL)
        : `${BASE_URL}/files/uploads/${movieId}.webp`;

      byUrl.set(match[0], {
        title: this.titleFromSlug(match[2]),
        url: this.resolveRelativeUrl(href, BASE_URL),
        image_url: imageUrl,
        kind: "movie",
        year: null,
      });
    });

    // Pasada 2: refinar título y año con el anchor dentro del <h3>
    $("h3 a[href*='/pelicula/']").each((_, el) => {
      const href = $(el).attr("href") || "";
      const keyMatch = href.match(/\/pelicula\/(\d+)\/([^/]+)\.html/i);
      if (!keyMatch) return;
      const item = byUrl.get(keyMatch[0]);
      if (!item) return;

      const h3Text = $(el).text().replace(/\s+/g, " ").trim();
      if (h3Text) item.title = h3Text;
      else if (($(el).attr("title") || "").trim()) item.title = ($(el).attr("title") || "").trim();

      const metaText = $(el).closest("h3").next().text() || "";
      const yearMatch = metaText.match(/\b(19|20)\d{2}\b/);
      if (yearMatch) item.year = parseInt(yearMatch[0], 10);
    });

    // Pasada 3: título desde atributo title para cards sin h3
    $('a[title][href*="/pelicula/"]').each((_, el) => {
      const href = $(el).attr("href") || "";
      const keyMatch = href.match(/\/pelicula\/\d+\/[^/]+\.html/i);
      if (!keyMatch) return;
      const item = byUrl.get(keyMatch[0]);
      if (item && !item.title) item.title = ($(el).attr("title") || "").trim();
    });

    items.push(...byUrl.values());
    return items;
  }

  /**
   * Metadatos de una página de detalle: OpenGraph + JSON-LD Movie Schema.
   * Nota verificada: og:title a veces trae un lema promocional, por lo que el
   * nombre del JSON-LD Movie tiene prioridad cuando existe.
   */
  private extractMetadata(html: string, url: string): {
    title: string;
    description: string;
    poster_url?: string;
    banner_url?: string;
    genres: string[];
    rating: number;
    year: number;
    content_type: ContentKind;
  } {
    const $ = cheerio.load(html);

    const ogTitle = $('meta[property="og:title"]').attr("content")?.trim() || "";
    const ogImage = $('meta[property="og:image"]').attr("content");
    const poster_url = ogImage ? this.resolveRelativeUrl(ogImage, url) : undefined;
    const ogDesc = $('meta[property="og:description"]').attr("content")?.trim() || "";

    // JSON-LD Movie Schema (fuente más precisa para nombre/género/rating/año)
    let ldName = "";
    let ldGenre = "";
    let ldRating = 0;
    let ldYear = 0;
    try {
      $('script[type="application/ld+json"]').each((_, el) => {
        const json = JSON.parse($(el).text());
        const nodes = Array.isArray(json) ? json : [json];
        for (const node of nodes) {
          if (node && node["@type"] === "Movie") {
            ldName = (node.name || "").trim();
            ldGenre = Array.isArray(node.genre) ? node.genre.join(", ") : node.genre || "";
            if (node.aggregateRating?.ratingValue) {
              ldRating = parseFloat(node.aggregateRating.ratingValue) || 0;
            }
            if (node.datePublished) {
              ldYear = parseInt(String(node.datePublished).slice(0, 4), 10) || 0;
            }
          }
        }
      });
    } catch {}

    const titleTag = $("title").text().replace(/\s*\|\s*TubePelis\s*$/i, "").trim();
    const title =
      ldName ||
      ogTitle ||
      $("h1").first().clone().children().remove().end().text().trim() ||
      titleTag ||
      "Película TubePelis";

    // Año: datePublished > title tag "(2026)" > og:description
    const yearMatch =
      html.match(/[（(](19|20)(\d{2})[)）]/) ||
      titleTag.match(/(19|20)(\d{2})/) ||
      ogDesc.match(/(19|20)(\d{2})/);
    const matchedYear = yearMatch?.[0].match(/(?:19|20)\d{2}/)?.[0];
    const year = ldYear || (matchedYear ? parseInt(matchedYear, 10) : 0);

    // Géneros: JSON-LD genre; fallback a keywords excluyendo términos SEO genéricos
    const genres: string[] = [];
    if (ldGenre) {
      ldGenre.split(",").forEach((g) => {
        const clean = g.trim();
        if (clean && !genres.includes(clean)) genres.push(clean);
      });
    }
    if (genres.length === 0) {
      const keywords = $('meta[name="keywords"]').attr("content") || "";
      keywords.split(",").forEach((g) => {
        const clean = g.trim();
        if (
          clean &&
          !/pelicula|online|gratis|ver|descargar|hd/i.test(clean) &&
          !genres.includes(clean) &&
          genres.length < 5
        ) {
          genres.push(clean);
        }
      });
    }

    return {
      title,
      description: ogDesc || $('meta[name="description"]').attr("content")?.trim() || "",
      poster_url,
      banner_url: poster_url,
      genres,
      rating: ldRating || 7.0,
      year,
      content_type: "movie",
    };
  }

  /**
   * Episodios (TubePelis es solo películas; se mantiene por contrato BaseAdapter).
   * Escanea enlaces típicos de serie/capítulo si el sitio los llegara a añadir.
   */
  private extractEpisodes(html: string, baseUrl: string): ExtractedEpisode[] {
    const $ = cheerio.load(html);
    const episodes: ExtractedEpisode[] = [];
    const seen = new Set<string>();

    $("a[href*='/ver/'], a[href*='/serie/'], a[href*='/capitulo/']").each((_, el) => {
      const href = $(el).attr("href");
      if (!href || seen.has(href)) return;
      seen.add(href);

      const fullUrl = this.resolveRelativeUrl(href, baseUrl);
      const linkText = $(el).text().replace(/\s+/g, " ").trim();
      const numberMatch = fullUrl.match(/(?:temporada-?|capitulo-?|episodio-?)(\d+)/i) || linkText.match(/(\d+)/);
      const number = numberMatch ? parseInt(numberMatch[1], 10) : episodes.length + 1;

      episodes.push({
        number,
        title: linkText || `Episodio ${number}`,
        url: fullUrl,
        server_name: "TubePelis",
      });
    });

    return episodes.sort((a, b) => a.number - b.number);
  }

  /**
   * CRÍTICO: decodifica los parámetros `v=` del proxy interno reproductor.php.
   * Cadena verificada contra el sitio real:
   *   data-src="https://www.tubepelis.com/reproductor.php?v=aHR0cHM6...%3D"
   *   → URL-decode (%3D → =) → Base64 decode → embed final (ej. https://voe.sx/...)
   */
  public decodeReproductorParam(html: string): string[] {
    const decoded: string[] = [];
    const regex = /reproductor\.php\?(?:[^"'>\s]*&)?v=([A-Za-z0-9+/=%]+)/gi;
    let m: RegExpExecArray | null;

    while ((m = regex.exec(html)) !== null) {
      try {
        const urlDecoded = decodeURIComponent(m[1]);
        const base64Decoded = Buffer.from(urlDecoded, "base64").toString("utf-8").trim();
        if (/^https?:\/\//i.test(base64Decoded) && !decoded.includes(base64Decoded)) {
          decoded.push(base64Decoded);
        }
      } catch {}
    }

    return decoded;
  }

  /**
   * Recolecta los embeds jugables del HTML del reproductor:
   * 1. iframes del player (atributo data-src o src) que apuntan al proxy
   *    interno reproductor.php?v=... → decodifica el Base64 a su embed real.
   * 2. iframes del player con embed directo (mp4/HLS/host externo) sin proxy.
   * 3. fallback: escaneo de todo el HTML por reproductor.php (scripts/otros attrs).
   */
  private extractPlayerEmbeds(html: string): string[] {
    const $ = cheerio.load(html);
    const embeds: string[] = [];

    $("iframe").each((_, el) => {
      const src = ($(el).attr("data-src") || $(el).attr("src") || "").trim();
      if (!/^https?:\/\//i.test(src)) return;
      if (/reproductor\.php/i.test(src)) {
        for (const decoded of this.decodeReproductorParam(src)) {
          if (!embeds.includes(decoded)) embeds.push(decoded);
        }
      } else if (!embeds.includes(src)) {
        embeds.push(src);
      }
    });

    for (const decoded of this.decodeReproductorParam(html)) {
      if (!embeds.includes(decoded)) embeds.push(decoded);
    }

    return embeds;
  }

  /**
   * Núcleo puro (sin fetch) de extracción de streams desde un HTML:
   * decodifica reproductor.php?v= → resuelve embeds → valida con MediaValidator.
   */
  public async resolveStreamsFromHtml(html: string): Promise<{
    stream_url: string;
    all_available_streams: string[];
  }> {
    const embedUrls = this.extractPlayerEmbeds(html);

    if (embedUrls.length === 0) {
      return { stream_url: "", all_available_streams: [] };
    }

    const resolutions = await Promise.all(
      embedUrls.map(async (embedUrl) => {
        try {
          return { embedUrl, resolved: await EmbedResolvers.resolve(embedUrl) };
        } catch {
          return { embedUrl, resolved: "" };
        }
      })
    );

    const candidates: string[] = [];
    for (const { embedUrl, resolved } of resolutions) {
      const candidate = resolved || embedUrl;
      if (candidate.startsWith("http") && !isDeadOrBlocked(candidate) && !candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }

    const validStreams = await MediaValidator.validateUrls(candidates);
    // Fallback: si el validador descarta todo (hosts desconocidos como playmogo/dood
    // con captcha), conservamos los embeds decodificados para no quedarnos sin failover.
    const finalStreams = (validStreams.length > 0 ? validStreams : candidates).filter((s) => !isDeadOrBlocked(s));

    return {
      stream_url: finalStreams[0] || "",
      all_available_streams: finalStreams,
    };
  }

  public async analyze(
    input: string,
    explicitType?: "auto" | "catalog" | "detail" | "stream"
  ): Promise<UniversalAnalysisResult> {
    const cleanInput = input.trim();

    // Entrada sin URL → tratarla como búsqueda
    if (!/^https?:\/\//i.test(cleanInput)) {
      const catalogItems = await this.search(cleanInput);
      return {
        page_type: "catalog",
        content_type: "movie",
        title: `Búsqueda TubePelis: ${cleanInput}`,
        description: `Resultados de búsqueda en TubePelis (${catalogItems.length} títulos)`,
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: 0,
        status: "Publicado",
        genres: [],
        source_domain: "tubepelis.com",
        episodes: [],
        catalog_items: catalogItems,
      };
    }

    const path = new URL(cleanInput).pathname.toLowerCase();

    // 1. Modo catálogo: Home o petición explícita
    if (explicitType === "catalog" || path === "/" || /^\/(buscar|categoria|categorias|letra)\//.test(path)) {
      const html = await this.fetchHtml(BASE_URL, 10000);
      const catalogItems = html ? this.extractCatalogItems(html) : [];

      return {
        page_type: "catalog",
        content_type: "movie",
        title: "Catálogo de Películas - TubePelis",
        description: `Catálogo completo de películas en TubePelis (${catalogItems.length} títulos)`,
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: 0,
        status: "Publicado",
        genres: [],
        source_domain: "tubepelis.com",
        episodes: [],
        catalog_items: catalogItems,
      };
    }

    // 2. Modo detalle (/pelicula/{id}/{slug}.html)
    const html = await this.fetchHtml(cleanInput, 10000);
    if (!html) {
      return {
        page_type: "detail",
        content_type: "movie",
        title: "Película TubePelis",
        description: "No se pudo cargar la página",
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: 0,
        status: "Desconocido",
        genres: [],
        source_domain: "tubepelis.com",
        episodes: [],
        catalog_items: [],
      };
    }

    const metadata = this.extractMetadata(html, cleanInput);
    const extractedEpisodes = this.extractEpisodes(html, cleanInput);
    const episodes = extractedEpisodes.length > 0
      ? extractedEpisodes
      : [{ number: 1, title: metadata.title || "Pelicula Completa", url: cleanInput, server_name: "TubePelis" }];

    let detectedStreams: string[] | undefined;
    if (!explicitType || explicitType === "stream" || explicitType === "auto") {
      try {
        const result = await this.resolveStreamsFromHtml(html);
        detectedStreams = result.all_available_streams.length > 0 ? result.all_available_streams : undefined;
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
      source_domain: "tubepelis.com",
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
   * Extrae streams de una página de película:
   * 1. Si la URL ya es un reproductor.php?v=..., decodifica directo.
   * 2. Si no, descarga el HTML y decodifica todos los v= encontrados.
   * 3. Resuelve cada embed con EmbedResolvers y valida con MediaValidator.
   */
  public async extractStream(targetUrl: string): Promise<{
    stream_url: string;
    all_available_streams: string[];
    title?: string;
  }> {
    const cleanUrl = targetUrl.trim();

    // Caso directo: ya nos dieron un enlace reproductor.php?v=...
    if (/reproductor\.php\?/i.test(cleanUrl) && /[?&]v=/i.test(cleanUrl)) {
      const html = `<iframe src="${cleanUrl}"></iframe>`;
      const result = await this.resolveStreamsFromHtml(html);
      return {
        stream_url: result.stream_url || cleanUrl,
        all_available_streams: result.all_available_streams.length > 0 ? result.all_available_streams : [cleanUrl],
      };
    }

    const html = await this.fetchHtml(cleanUrl, 12000);
    if (!html) {
      return { stream_url: cleanUrl, all_available_streams: [cleanUrl] };
    }

    const $ = cheerio.load(html);
    const title =
      $('script[type="application/ld+json"]').map((_, el) => {
        try {
          const json = JSON.parse($(el).text());
          const nodes = Array.isArray(json) ? json : [json];
          const movie = nodes.find((n: any) => n?.["@type"] === "Movie");
          return movie?.name || "";
        } catch {
          return "";
        }
      }).get().find(Boolean) as string | undefined ||
      $("h1").first().clone().children().remove().end().text().trim() ||
      undefined;

    const result = await this.resolveStreamsFromHtml(html);

    if (result.all_available_streams.length === 0) {
      // Fallback: extracción genérica de embeds del HTML
      const genericStreams = await super.extractStream(cleanUrl);
      return { ...genericStreams, title };
    }

    return {
      stream_url: result.stream_url || cleanUrl,
      all_available_streams: result.all_available_streams,
      title,
    };
  }

  private titleFromSlug(slug: string): string {
    return slug
      .replace(/-/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase())
      .trim();
  }
}
