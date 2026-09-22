import * as cheerio from "cheerio";
import { BaseScraperAdapter } from "../BaseAdapter";
import { UniversalAnalysisResult, ContentKind, ExtractedEpisode, ExtractedCatalogItem } from "../../types";
import { EmbedResolvers, isSupportedServer } from "../../resolvers";

const BASE_URL = "https://latanime.org";

const DEAD_OR_BLOCKED_HOST_PATTERNS = [
  /cfglobalcdn\.com/i,
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
 * LatAnime normally publishes one continuous episode list, but some fichas
 * include temporada markers in the link text/slug (S02, temporada-2, etc.).
 * Preserve that signal so the multi-source catalog can attach the link to the
 * correct MediaEpisode instead of silently putting every episode in season 1.
 */
export function parseLatAnimeSeason(value: string): number | undefined {
  const normalized = decodeURIComponent(String(value || "")).toLowerCase();
  const patterns = [
    /(?:temporada|season|temp|tp)[\s._-]*(\d{1,2})(?:\b|[-_])/i,
    /\bs(\d{1,2})e\d{1,4}\b/i,
    /\b(\d{1,2})(?:st|nd|rd|th)[\s._-]*season\b/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const season = match ? Number(match[1]) : 0;
    if (Number.isInteger(season) && season > 0 && season <= 99) return season;
  }
  return undefined;
}

export function parseLatAnimeLanguage(
  value: string,
  badges: string[] = []
): {
  audio_language: string;
  subtitle_language?: string;
  language: "dub" | "sub";
  link_type: "dub" | "sub";
} {
  const normText = `${value} ${badges.join(" ")}`.toLowerCase();

  if (/(?:-|\b)castellano\b/i.test(normText)) {
    return {
      audio_language: "es-ES",
      language: "dub",
      link_type: "dub",
    };
  }
  if (/(?:-|\b)catalan\b|-catala\b/i.test(normText)) {
    return {
      audio_language: "ca",
      language: "dub",
      link_type: "dub",
    };
  }
  if (/(?:-|\b)latino\b/i.test(normText)) {
    return {
      audio_language: "es-419",
      language: "dub",
      link_type: "dub",
    };
  }
  return {
    audio_language: "ja",
    subtitle_language: "es",
    language: "sub",
    link_type: "sub",
  };
}

const MAX_RETURNED_STREAMS = 5;

/**
 * Adaptador para latanime.org
 *
 * - Catálogo/Búsqueda: enlaces `a[href^="https://latanime.org/anime/"]` (búsqueda en /buscar?q=)
 * - Detalles: metadatos OpenGraph + sinopsis (.sinopsis, p.text-sm, p.description)
 * - Episodios: enlaces `a[href*="/ver/"]` con número al final de la URL (-episodio-N)
 * - Video: los servidores (Filemoon, DoodStream, Mp4Upload, VOE...) están en el atributo
 *   `data-player` codificados en Base64. Se decodifican y se resuelven con EmbedResolvers.
 */
export class LatAnimeAdapter extends BaseScraperAdapter {
  readonly id = "latanime";
  readonly name = "LatAnime (Animes)";
  readonly supportedDomains = ["latanime.org"];

  canHandle(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.includes("latanime.org");
  }

  /**
   * Búsqueda de animes en latanime.org (/buscar?q=...)
   */
  public async search(query: string): Promise<ExtractedCatalogItem[]> {
    const searchUrl = `${BASE_URL}/buscar?q=${encodeURIComponent(query.trim())}`;
    const html = await this.fetchHtml(searchUrl, 10000);
    if (!html) return [];
    return this.extractCatalogItems(html);
  }

  /**
   * Extrae items de catálogo desde el Home o resultados de búsqueda.
   * Los enlaces a animes son `a[href^="https://latanime.org/anime/"]`.
   */
  private extractCatalogItems(html: string): ExtractedCatalogItem[] {
    const $ = cheerio.load(html);
    const items: ExtractedCatalogItem[] = [];
    const seen = new Set<string>();

    $("a[href*='/anime/']").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const url = this.resolveRelativeUrl(href, BASE_URL);
      // Solo enlaces absolutos con origen exacto latanime.org y ruta de ficha /anime/
      if (!url || !url.startsWith(`${BASE_URL}/anime/`)) return;
      if (seen.has(url)) return;
      seen.add(url);

      const $link = $(el);
      const $h3 = $link.find("h3").first();
      const $img = $link.find("img").first();

      // Imagen: priorizar data-src (lazy load lozad), ignorar placeholders
      const rawImg = $img.attr("data-src") || $img.attr("src") || "";
      const imageUrl =
        rawImg && !rawImg.includes("capblank")
          ? this.resolveRelativeUrl(rawImg, BASE_URL)
          : null;

      // Título: h3 de la card, alt de la imagen, texto del enlace o slug
      const title =
        $h3.text().trim() ||
        ($img.attr("alt") || "").trim() ||
        $link.text().trim() ||
        this.titleFromSlug(href);

      // Año: último span de .seriedetails suele traer el año junto al ícono de estrella
      const detailsText = $link.find(".seriedetails span").last().text().trim();
      const yearMatch = detailsText.match(/(19|20)\d{2}/);
      const year = yearMatch ? parseInt(yearMatch[0], 10) : null;

      items.push({
        title,
        url: href,
        image_url: imageUrl,
        kind: "anime",
        year,
      });
    });

    return items;
  }

  /**
   * Metadatos de una página de detalle usando OpenGraph y la sinopsis del sitio.
   */
  private extractMetadata(html: string, url: string): {
    title: string;
    description: string;
    poster_url?: string;
    banner_url?: string;
    genres: string[];
    year: number;
    content_type: ContentKind;
  } {
    const $ = cheerio.load(html);

    const ogTitle = $('meta[property="og:title"]').attr("content") || "";
    const h1Title = $("h1").first().text().trim();
    const title =
      ogTitle.replace(/\s*[-–—]\s*Latanime\s*$/i, "").trim() ||
      h1Title ||
      this.titleFromSlug(url) ||
      "Anime";

    const ogImage = $('meta[property="og:image"]').attr("content");
    const poster_url = ogImage ? this.resolveRelativeUrl(ogImage, url) : undefined;

    const ogDesc = $('meta[property="og:description"]').attr("content") || "";
    const sinopsis =
      $(".sinopsis").first().text().trim() ||
      $("p.text-sm").first().text().trim() ||
      $("p.description").first().text().trim();
    const description = ogDesc || sinopsis || "";

    const genres: string[] = [];
    $("a[href*='/genero/'], .genres a, .meta-genres a").each((_, el) => {
      const genre = $(el).text().trim();
      if (genre && !genres.includes(genre)) genres.push(genre);
    });

    const yearMatch =
      html.match(/Año[\s:]*(\d{4})/i)?.[1] ||
      description.match(/(19\d{2}|20[0-2]\d)/)?.[0] ||
      html.match(/release_date[\s:]*["'](19\d{2}|20[0-2]\d)/i)?.[1];
    // Defecto #16/#24: desconocido -> 0 (nunca el año corriente como dato falso)
    const year = yearMatch ? parseInt(yearMatch, 10) : 0;

    return {
      title,
      description,
      poster_url,
      banner_url: poster_url,
      genres,
      year,
      content_type: "anime",
    };
  }

  /**
   * Lista de episodios: todos los `a` cuyo href contiene "/ver/".
   * El número de episodio se extrae de la URL (formato: ...-episodio-N).
   */
  private extractEpisodes(html: string, baseUrl: string): ExtractedEpisode[] {
    const $ = cheerio.load(html);
    const episodes: ExtractedEpisode[] = [];
    const seen = new Set<string>();

    const badges: string[] = [];
    $(".seriedetails span, .genres a, .meta-genres a").each((_, el) => {
      const text = $(el).text().trim();
      if (text) badges.push(text);
    });

    $("a[href*='/ver/']").each((_, el) => {
      const href = $(el).attr("href");
      if (!href || seen.has(href)) return;
      seen.add(href);

      const fullUrl = this.resolveRelativeUrl(href, baseUrl);
      const numberMatch = fullUrl.match(/-episodio-(\d+)/) || fullUrl.match(/(\d+)\s*$/);
      const number = numberMatch ? parseInt(numberMatch[1], 10) : episodes.length + 1;
      const linkText = $(el).text().replace(/\s+/g, " ").trim();
      const capMatch = linkText.match(/capitulo\s*(\d+)/i);
      const title = capMatch ? `Capitulo ${capMatch[1]}` : linkText || `Episodio ${number}`;
      const season = parseLatAnimeSeason(`${fullUrl} ${linkText}`);
      const lang = parseLatAnimeLanguage(`${fullUrl} ${linkText} ${baseUrl}`, badges);

      episodes.push({
        number,
        ...(season ? { season } : {}),
        title,
        url: fullUrl,
        server_name: "LatAnime",
        sources: [
          {
            url: fullUrl,
            source_site: "latanime",
            link_type: lang.link_type,
            language: lang.language,
            audio_language: lang.audio_language,
            subtitle_language: lang.subtitle_language,
            host: "latanime.org",
            is_verified: true,
          },
        ],
      });
    });

    return episodes.sort((a, b) => a.number - b.number);
  }

  /**
   * Decodifica los valores Base64 del atributo data-player y devuelve las URLs de iframe.
   */
  private decodeDataPlayers(html: string): string[] {
    const $ = cheerio.load(html);
    const iframes: string[] = [];

    $("[data-player]").each((_, el) => {
      const encoded = $(el).attr("data-player");
      if (!encoded) return;
      try {
        const decoded = Buffer.from(encoded, "base64").toString("utf-8").trim();
        if (/^https?:\/\//i.test(decoded) && !isDeadOrBlocked(decoded) && !iframes.includes(decoded)) {
          iframes.push(decoded);
        }
      } catch {}
    });

    return iframes;
  }

  public async analyze(
    input: string,
    explicitType?: "auto" | "catalog" | "detail" | "stream"
  ): Promise<UniversalAnalysisResult> {
    const cleanUrl = input.trim();
    const url = new URL(cleanUrl);
    const path = url.pathname.toLowerCase();

    // 1. Modo catálogo: home, /animes (con paginación ?p=N), búsqueda, género,
    // letra, emisión o petición explícita.
    const isCatalogRoute =
      path === "/" || /^\/(animes|browse|letra|emision)(\/.*)?$/.test(path) || path.startsWith("/buscar");
    if (explicitType === "catalog" || isCatalogRoute) {
      // Respetar la URL pedida (paginación ?p=N, búsqueda ?q=...); el home sin
      // ruta usa BASE_URL tal cual.
      const target = path === "/" ? BASE_URL : `${url.origin}${url.pathname}${url.search}`;
      const html = await this.fetchHtml(target, 10000);
      if (!html) throw new Error(`FETCH_FAILED: ${target}`);
      const catalogItems = this.extractCatalogItems(html);

      return {
        page_type: "catalog",
        content_type: "anime",
        title: path.startsWith("/buscar") ? `Búsqueda en LatAnime` : "Catálogo de Animes - LatAnime",
        description: `Catálogo completo de animes en LatAnime (${catalogItems.length} títulos)`,
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: 0,
        status: "Publicado",
        genres: [],
        source_domain: "latanime.org",
        episodes: [],
        catalog_items: catalogItems,
      };
    }

    // 2. Modo detalle
    const html = await this.fetchHtml(cleanUrl, 10000);
    if (!html) {
      return {
        page_type: "detail",
        content_type: "anime",
        title: "Anime LatAnime",
        description: "No se pudo cargar la página",
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: 0,
        status: "Desconocido",
        genres: [],
        source_domain: "latanime.org",
        episodes: [],
        catalog_items: [],
      };
    }

    const metadata = this.extractMetadata(html, cleanUrl);
    const episodes = this.extractEpisodes(html, cleanUrl);

    let detectedStreams: string[] | undefined;
    if (!explicitType || explicitType === "stream" || explicitType === "auto") {
      // Los players viven solo en páginas de episodio (/ver/...). Si la URL
      // ya es de episodio, usarla tal cual; si es ficha, caer al ep1.
      const isEpisodePage = /\/ver\//.test(path) || /\/ver\//.test(cleanUrl);
      const target = isEpisodePage ? cleanUrl : episodes[0]?.url;
      if (target) {
        try {
          const streamResult = await this.extractStream(target);
          // En fichas sin /ver/ el fallback genérico captura thumbnails:
          // no contaminar detected_streams con imágenes.
          const mediaOnly = streamResult.all_available_streams.filter(
            (s) => !/\.(jpe?g|png|webp|gif)(\?|$)/i.test(s)
          );
          if (mediaOnly.length > 0) detectedStreams = mediaOnly;
        } catch {}
      }
    }

    return {
      page_type: "detail",
      content_type: metadata.content_type,
      title: metadata.title,
      description: metadata.description,
      poster_url: metadata.poster_url || null,
      banner_url: metadata.banner_url || null,
      rating: 7.0,
      year: metadata.year,
      status: "Publicado",
      genres: metadata.genres,
      source_domain: "latanime.org",
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
   * Extrae streams de video de una página de episodio:
   * 1. Busca elementos [data-player] y decodifica su Base64 -> URLs de iframe.
   * 2. Resuelve cada iframe con EmbedResolvers para obtener .m3u8/.mp4 directos.
   * 3. Retorna el primer stream directo exitoso y lista el resto.
   */
  public async extractStream(targetUrl: string): Promise<{
    stream_url: string;
    all_available_streams: string[];
    title?: string;
  }> {
    const cleanUrl = targetUrl.trim();
    const html = await this.fetchHtml(cleanUrl, 12000);

    if (!html) {
      return { stream_url: "", all_available_streams: [] };
    }

    const $ = cheerio.load(html);
    // En páginas de episodio el primer <h1> es el botón "Reportar episodio":
    // priorizar og:title (sin sufijo "- Latanime") y usar h1 solo como fallback.
    const title =
      $('meta[property="og:title"]').attr("content")?.replace(/\s*[-–—]\s*Latanime\s*$/i, "").trim() ||
      $("h2").filter((_, el) => /-\s*\d+\s*$/.test($(el).text())).first().text().replace(/\s*-\s*\d+\s*$/, "").trim() ||
      $("h1").first().text().trim() ||
      undefined;

    const iframeUrls = this.decodeDataPlayers(html);
    if (iframeUrls.length === 0) {
      // Algunas filas antiguas guardan la ficha /anime/<slug> en vez del
      // episodio /ver/<slug>-episodio-N. La ficha no contiene los players,
      // pero sí la lista de episodios: resolver el primero evita anunciarla
      // como una fuente vacía.
      if (/\/anime\//i.test(new URL(cleanUrl).pathname)) {
        const firstEpisode = this.extractEpisodes(html, cleanUrl)[0];
        if (firstEpisode?.url && firstEpisode.url !== cleanUrl) {
          const nested = await this.extractStream(firstEpisode.url);
          return { ...nested, title: nested.title || title };
        }
      }
      // Fallback: extracción genérica de embeds del HTML
      const genericStreams = await super.extractStream(cleanUrl);
      const safe = genericStreams.all_available_streams.filter((value) => this.isPlayableCandidate(value));
      return {
        stream_url: safe[0] || "",
        all_available_streams: safe.slice(0, 4),
        title,
      };
    }

    // Resolver todos los iframes en paralelo con timeout de seguridad (4.5s).
    // El resultado crítico, sin embargo, no debe esperar al último servidor:
    // en LatAnime suele haber un Uqload/SprintCDN sano junto a varios embeds
    // caídos. En cuanto uno devuelve HLS vivo devolvemos ese candidato y
    // dejamos los locators restantes para el fallback JIT del reproductor.
    const resolutionPromises = iframeUrls.map(async (iframeUrl) => {
      try {
        const timeoutPromise = new Promise<{ iframeUrl: string; resolved: string }>((resolve) =>
          setTimeout(() => resolve({ iframeUrl, resolved: "" }), 4500)
        );
        const resolvePromise = EmbedResolvers.resolve(iframeUrl).then((resolved) => ({ iframeUrl, resolved }));
        return await Promise.race([resolvePromise, timeoutPromise]);
      } catch {
        return { iframeUrl, resolved: "" };
      }
    });
    const liveDirectCache = new Map<string, boolean>();
    const firstLiveDirect = Promise.any(resolutionPromises.map(async (resolution) => {
      const { iframeUrl, resolved } = await resolution;
      if (!this.isDirectMedia(resolved) || isDeadOrBlocked(resolved)) throw new Error("not_direct");
      const live = await this.isLiveMedia(resolved);
      liveDirectCache.set(resolved, live);
      if (!live) throw new Error("direct_not_live");
      return { iframeUrl, resolved };
    }));

    try {
      const first = await firstLiveDirect;
      const fallbackEmbeds = iframeUrls
        .filter((iframeUrl) => iframeUrl !== first.iframeUrl && this.isPlayableCandidate(iframeUrl) && !isDeadOrBlocked(iframeUrl));
      return {
        stream_url: first.resolved,
        all_available_streams: [first.resolved, ...fallbackEmbeds].slice(0, MAX_RETURNED_STREAMS),
        title,
      };
    } catch {
      // Ningún directo sano apareció pronto; reutilizar las resoluciones ya
      // iniciadas para conservar la selección completa de servidores.
    }

    const resolutions = await Promise.all(resolutionPromises);

    const all_available_streams: string[] = [];
    const directStreams: string[] = [];

    for (const { iframeUrl, resolved } of resolutions) {
      // An empty resolution is reserved for a provider that positively
      // reported the embed as unavailable (for example an expired Uqload
      // file). Do not re-add that same dead iframe as a fallback candidate.
      if (resolved && this.isPlayableCandidate(resolved) && !isDeadOrBlocked(resolved) && !all_available_streams.includes(resolved)) {
        all_available_streams.push(resolved);
      }
      // Stream directo confirmado (.m3u8/.mp4) distinto del propio iframe
      const isDirectMedia = this.isDirectMedia(resolved) && resolved !== iframeUrl;
      if (isDirectMedia && !isDeadOrBlocked(resolved) && !directStreams.includes(resolved)) {
        directStreams.push(resolved);
      }
      // El iframe crudo solo si no se obtuvo media directa para ese player
      if (resolved !== "" && !isDirectMedia && this.isPlayableCandidate(iframeUrl) && !isDeadOrBlocked(iframeUrl) && !all_available_streams.includes(iframeUrl)) {
        all_available_streams.push(iframeUrl);
      }
    }

    const liveDirectStreams = directStreams.length > 0
      ? (await Promise.all(directStreams.map(async (stream) => {
          const live = liveDirectCache.has(stream) ? liveDirectCache.get(stream) : await this.isLiveMedia(stream);
          liveDirectCache.set(stream, Boolean(live));
          return live ? stream : null;
        })))
        .filter((stream): stream is string => Boolean(stream))
      : [];
    const finalStreams = liveDirectStreams.length > 0
      ? [...liveDirectStreams, ...all_available_streams.filter((s) => !directStreams.includes(s))]
      : all_available_streams.filter((s) => !directStreams.includes(s));

    // Conservar varios candidatos permite llegar a un servidor posterior cuando
    // los primeros embeds del episodio están caducados. La UI los agrupa y no
    // muestra una lista gigante; el límite aquí evita inflar la respuesta.
    const directMedia = finalStreams.filter((u) => this.isDirectMedia(u));
    const backupEmbeds = finalStreams.filter((u) => !directMedia.includes(u));
    const resultStreams = (directMedia.length > 0
      ? [...directMedia, ...backupEmbeds]
      : [...backupEmbeds, ...directMedia]
    ).slice(0, MAX_RETURNED_STREAMS);

    return {
      stream_url: resultStreams[0] || "",
      all_available_streams: resultStreams,
      title,
    };
  }

  private isDirectMedia(value: string): boolean {
    return EmbedResolvers.isDirectMediaUrl(value) && /^(?:https?):\/\//i.test(value);
  }

  /**
   * Un manifest firmado puede responder 200 aunque su primer recurso ya esté
   * caído. Comprueba el manifest y un recurso descendiente antes de anunciarlo
   * al coordinador para evitar cascadas de fallbacks en el reproductor.
   */
  private async isLiveMedia(value: string, depth = 0): Promise<boolean> {
    if (!this.isDirectMedia(value)) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(value, {
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
          Referer: `${BASE_URL}/`,
          Accept: "*/*",
          ...(value.includes(".mp4") ? { Range: "bytes=0-1023" } : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (value.includes(".mp4")) return contentType.includes("video/") || contentType.includes("octet-stream");
      const body = (await response.text()).slice(0, 256_000);
      if (!/^#EXTM3U/i.test(body) || depth >= 2) return false;
      const next = body.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
      if (!next) return false;
      const child = new URL(next, value).toString();
      if (this.isDirectMedia(child)) return this.isLiveMedia(child, depth + 1);
      const segmentController = new AbortController();
      const segmentTimer = setTimeout(() => segmentController.abort(), 4_000);
      try {
        const segment = await fetch(child, { redirect: "follow", headers: { Referer: value, Range: "bytes=0-1023" }, signal: segmentController.signal });
        const segmentType = String(segment.headers.get("content-type") || "").toLowerCase();
        await segment.body?.cancel().catch(() => undefined);
        return segment.ok && !segmentType.includes("text/html") && !segmentType.includes("image/");
      } finally {
        clearTimeout(segmentTimer);
      }
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private isPlayableCandidate(value: string): boolean {
    if (!value || /\.(?:jpe?g|png|gif|webp|svg)(?:[?#]|$)/i.test(value)) return false;
    return this.isDirectMedia(value) || isSupportedServer(value);
  }

  private titleFromSlug(url: string): string {
    const match = url.match(/\/anime\/([^/]+)/);
    if (!match) return "Anime LatAnime";
    return match[1]
      .replace(/-/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase())
      .trim();
  }
}
