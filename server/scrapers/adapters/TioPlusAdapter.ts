import * as cheerio from "cheerio";
import { BaseScraperAdapter } from "../BaseAdapter";
import { UniversalAnalysisResult, ContentKind, ExtractedEpisode, ExtractedCatalogItem } from "../../types";
import { EmbedResolvers } from "../../resolvers";
import { MediaValidator } from "../../validator";

const BASE_URL = "https://tioplus.app";

/**
 * Limpia el og:title del sitio: "Ver {Título} (Año) Online Gratis Español - TioPlus"
 * -> "{Título} (Año)". Formato verificado en páginas reales.
 */
function cleanTitle(raw: string): string {
  return raw
    .replace(/\s*[-–—]\s*TioPlus(\.net|\.app)?\s*$/i, "")
    .replace(/^Ver\s+/i, "")
    .replace(/\s+Online Gratis\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Adaptador para tioplus.app
 *
 * - Catálogo/Búsqueda: `<article>` (o `article.item`) con `a.itemA`; búsqueda vía API interna
 *   `GET /api/search/{query}` que devuelve el mismo fragmento HTML de articles.
 *   El tipo de contenido viene en `span.typeItem` (clases: movie | anime | serie).
 * - Metadatos: og:title y og:image (posters/banners de image.tmdb.org), año en enlace /year/,
 *   rating en `.genres.rating`, géneros en `.genres a[href*="/genero/"]`.
 * - Episodios: variable global `var seasonsJson = {"1":[{title,image,season,episode},...],...}`
 *   con TODAS las temporadas; fallback DOM `#episodeList article.item a[href*="/season/"]`.
 *   Rutas: /{serie|anime}/{slug}/season/{n}/episode/{n}
 * - Video (crítico): iframes ofuscados en Base64 dentro de los atributos `data-video`,
 *   `data-server` y `data-tr` de los botones de servidores. Mecanismo verificado en app.js:
 *   el reproductor se construye como `/player/{btoa(valor_del_atributo)}` y la página
 *   `/player/{token}` redirige vía `window.location.href` al embed real (ej. vidhideplus.com).
 *   Si el valor decodifica directamente a http(s), se usa tal cual.
 */
export class TioPlusAdapter extends BaseScraperAdapter {
  readonly id = "tioplus";
  readonly name = "TioPlus";
  readonly supportedDomains = ["tioplus.app", "www.tioplus.app"];

  /**
   * Players SPA tipo "pelisplus" (strp2p/4meplayer/upns y sus rotaciones de dominio).
   * Verificado manualmente el 2026-08-21: son apps JS que cifran el token del
   * fragmento con WebCrypto contra su API interna (/api/v1/player?t=), responden
   * {"error":"Token is invalid"} a peticiones sin sesión JS, usan `restrictEmbed`
   * para bloquear iframes externos y detectan headless browsers. No resolubles
   * server-side ni reproducibles en el reproductor de la app -> se descartan.
   */
  private static readonly UNPLAYABLE_SPA_HOSTS = [
    "strp2p.com",
    "4meplayer.pro",
    "upns.pro",
  ];

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

  canHandle(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.includes("tioplus.app");
  }

  /**
   * Detecta URLs de players SPA no reproducibles o hosts caídos.
   */
  private isUnplayablePlayerUrl(url: string): boolean {
    const lower = url.toLowerCase();
    if (TioPlusAdapter.UNPLAYABLE_SPA_HOSTS.some((h) => lower.includes(h))) return true;
    if (TioPlusAdapter.DEAD_OR_BLOCKED_HOST_PATTERNS.some((p) => p.test(url))) return true;
    try {
      const u = new URL(url);
      return u.pathname === "/" && u.hash.length > 1;
    } catch {
      return false;
    }
  }

  /**
   * Búsqueda vía la API interna del sitio (`/api/search/{q}` devuelve HTML de articles).
   * Fallback: catálogo del Home filtrado localmente.
   */
  public async search(query: string): Promise<ExtractedCatalogItem[]> {
    const q = query.trim();
    if (!q) return [];

    const html = await this.fetchHtml(`${BASE_URL}/api/search/${encodeURIComponent(q)}`, 10000);
    if (html) {
      const items = this.extractCatalogItems(html);
      if (items.length > 0) return items;
    }

    // Fallback: Home + filtrado local
    const homeHtml = await this.fetchHtml(BASE_URL, 10000);
    if (!homeHtml) return [];
    const all = this.extractCatalogItems(homeHtml);
    if (all.length === 0) return [];
    const lowerQ = q.toLowerCase();
    const filtered = all.filter((i) => i.title.toLowerCase().includes(lowerQ));
    return filtered.length > 0 ? filtered : all.slice(0, 20);
  }

  /**
   * Extrae items de catálogo desde HTML (Home, listados o resultados de la API de búsqueda).
   * Prioridad `<article>`; fallback `div.item`.
   */
  public extractCatalogItems(html: string): ExtractedCatalogItem[] {
    const $ = cheerio.load(html);
    const items: ExtractedCatalogItem[] = [];
    const seen = new Set<string>();

    const processCard = ($card: cheerio.Cheerio<any>) => {
      const $link = $card.is("a") ? $card : $card.find("a").first();
      const href = ($link.attr("href") || "").trim();
      if (!href) return;
      const fullUrl = this.resolveRelativeUrl(href, BASE_URL);
      if (!fullUrl || seen.has(fullUrl)) return;
      seen.add(fullUrl);

      const $img = $card.find("img").first();
      const rawImg = $img.attr("data-src") || $img.attr("src") || "";
      const imageUrl =
        rawImg && !rawImg.includes("placeholder")
          ? this.resolveRelativeUrl(rawImg.trim(), BASE_URL)
          : null;

      const h2Title = $card.find("h2").first().text().trim();
      const altTitle = ($img.attr("alt") || "").trim();
      const title = h2Title || altTitle || this.titleFromSlug(fullUrl);
      if (!title || title.length < 2) return;

      const typeClass = ($card.find(".typeItem").attr("class") || "").toLowerCase();
      const kind = this.kindFromTypeItem(typeClass) || this.kindFromUrl(fullUrl);

      const yearMatch = title.match(/\((\d{4})\)\s*$/);
      const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

      items.push({
        title: title.replace(/\s+/g, " ").trim(),
        url: fullUrl,
        image_url: imageUrl,
        kind,
        year,
      });
    };

    $("article").each((_, el) => processCard($(el)));

    // Fallback especificado: div.item sin <article>
    if (items.length === 0) {
      $("div.item").each((_, el) => processCard($(el)));
    }

    return items;
  }

  /**
   * Metadatos de página de detalle: OpenGraph (og:title / og:image de image.tmdb.org),
   * descripción, géneros, año (/year/) y rating.
   */
  public extractMetadata(
    html: string,
    url: string
  ): {
    title: string;
    description: string;
    poster_url?: string;
    banner_url?: string;
    genres: string[];
    year: number;
    rating: number;
    content_type: ContentKind;
  } {
    const $ = cheerio.load(html);

    const ogTitle = $('meta[property="og:title"]').attr("content") || "";
    const h1Title = $("h1.slugh1").first().text().trim() || $("h1").first().text().trim();
    const cleanOgTitle = cleanTitle(ogTitle);
    const title =
      cleanOgTitle ||
      h1Title ||
      $("title").text().trim() ||
      this.titleFromSlug(url);

    // og:image mantiene el enlace a image.tmdb.org cuando el sitio lo usa
    let ogImage =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") ||
      "";
    if (!ogImage) {
      const bgStyle = $(".bg").first().attr("style") || "";
      const bgMatch = bgStyle.match(/url\(["']?([^"')]+)["']?\)/i);
      if (bgMatch) ogImage = bgMatch[1];
    }
    const poster_url = ogImage ? this.resolveRelativeUrl(ogImage.trim(), url) : undefined;

    const ogDesc = $('meta[property="og:description"]').attr("content") || "";
    const siteDesc = $(".description p").first().text().trim();
    const description = siteDesc || ogDesc.replace(/^Ver\s+.*Online Gratis.*$/i, "").trim();

    const genres: string[] = [];
    $(".genres a[href*='/genero/']").each((_, el) => {
      const g = $(el).text().trim();
      if (g && !genres.includes(g)) genres.push(g);
    });

    const yearMatch =
      html.match(/href="[^"]*\/year\/(\d{4})"/i) ||
      title.match(/\((\d{4})\)/) ||
      description.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();

    // El HTML real es "<b>Rating:</b> 7.3" -> permitir etiquetas de cierre intermedias
    const ratingMatch = html.match(/Rating:\s*(?:<\/b>)?\s*([\d]+(?:[.,]\d+)?)/i);
    const rating = ratingMatch ? parseFloat(ratingMatch[1].replace(",", ".")) : 0;

    return {
      title,
      description,
      poster_url,
      banner_url: poster_url,
      genres,
      year: isNaN(year) ? new Date().getFullYear() : year,
      rating,
      content_type: this.kindFromUrl(url) || "series",
    };
  }

  /**
   * Lista completa de episodios:
   * 1. `var seasonsJson = {...}` (todas las temporadas, formato verificado)
   * 2. Fallback DOM: `#episodeList article.item a[href*="/season/"]`
   */
  public extractEpisodes(html: string, baseUrl: string): ExtractedEpisode[] {
    // 1. Variable global seasonsJson
    const jsonMatch = html.match(/var\s+seasonsJson\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (jsonMatch) {
      try {
        const parsed: unknown = JSON.parse(jsonMatch[1]);
        if (parsed && typeof parsed === "object") {
          const episodes: ExtractedEpisode[] = [];
          const seenNums = new Set<string>();
          for (const seasonArr of Object.values(parsed as Record<string, unknown>)) {
            if (!Array.isArray(seasonArr)) continue;
            for (const ep of seasonArr as any[]) {
              const season = Number(ep?.season);
              const number = Number(ep?.episode);
              if (isNaN(number) || isNaN(season)) continue;
              const key = `${season}-${number}`;
              if (seenNums.has(key)) continue;
              seenNums.add(key);
              episodes.push({
                number,
                title: `${ep?.title || `Episodio ${number}`} (T${season})`,
                url: this.buildEpisodeUrl(baseUrl, season, number),
                source_type: "series",
                server_name: "TioPlus",
              });
            }
          }
          if (episodes.length > 0) {
            return episodes.sort((a, b) => a.number - b.number);
          }
        }
      } catch {}
    }

    // 2. Fallback DOM
    const $ = cheerio.load(html);
    const episodes: ExtractedEpisode[] = [];
    const seen = new Set<string>();

    $("#episodeList article a[href], article.item a[href]").each((_, el) => {
      const href = ($(el).attr("href") || "").trim();
      if (!href || !href.includes("/season/")) return;
      const fullUrl = this.resolveRelativeUrl(href, BASE_URL);
      if (seen.has(fullUrl)) return;
      seen.add(fullUrl);

      const m = fullUrl.match(/\/season\/(\d+)\/episode\/(\d+)/i);
      const season = m ? parseInt(m[1], 10) : 1;
      const number = m ? parseInt(m[2], 10) : episodes.length + 1;
      const linkText = $(el).find("h2").first().text().replace(/\s+/g, " ").trim();

      episodes.push({
        number,
        title: linkText || `Episodio ${number} (T${season})`,
        url: fullUrl,
        server_name: "TioPlus",
      });
    });

    return episodes.sort((a, b) => a.number - b.number);
  }

  /**
   * CRÍTICO: decodifica los iframes ofuscados en Base64 de los botones de servidores.
   * Atributos soportados: data-video, data-server y data-tr (el sitio real usa los dos últimos).
   *
   * Casos verificados:
   * a) El valor decodifica directo a http(s) -> se usa tal cual.
   * b) El valor es Base64 opaco (ej. "cDI3Q2...") -> el reproductor real es
   *    `${BASE_URL}/player/${btoa(valor)}` (mecanismo de app.js); la página /player/
   *    contiene `window.location.href = '<embed>'` con el iframe real.
   */
  public decodeDataVideos(html: string): string[] {
    const $ = cheerio.load(html);
    const candidates: string[] = [];
    const seen = new Set<string>();

    $("[data-video], [data-server], [data-tr]").each((_, el) => {
      const $el = $(el);
      const raw =
        $el.attr("data-video") || $el.attr("data-server") || $el.attr("data-tr") || "";
      const val = raw.trim();
      if (!val || seen.has(val)) return;
      seen.add(val);

      const decoded = this.decodeVideoValue(val);
      if (decoded && !candidates.includes(decoded)) candidates.push(decoded);
    });

    return candidates;
  }

  /**
   * Decodifica un valor individual de data-video/data-server/data-tr.
   * Devuelve URL directa (http) o URL del reproductor interno /player/{token}.
   */
  private decodeVideoValue(val: string): string | null {
    if (/^https?:\/\//i.test(val)) return val;

    let decoded = "";
    try {
      decoded = Buffer.from(val, "base64").toString("utf-8");
    } catch {
      return null;
    }

    // Nivel 1: el Base64 revela directamente el iframe/enlace
    if (/^https?:\/\//i.test(decoded)) return decoded;

    // Nivel 2: doble codificación (caso real del sitio: decodifica a otro Base64 opaco)
    if (/^[A-Za-z0-9+/=]+$/.test(decoded) && decoded.length >= 16) {
      try {
        const decoded2 = Buffer.from(decoded, "base64").toString("utf-8");
        if (/^https?:\/\/[\x20-\x7E]+$/.test(decoded2)) return decoded2;
      } catch {}
    }

    // Nivel 3: token opaco -> reproductor interno /player/{btoa(valor)} (app.js verificado)
    if (/^[A-Za-z0-9+/=]{8,}$/.test(val)) {
      return `${BASE_URL}/player/${Buffer.from(val, "binary").toString("base64")}`;
    }

    return null;
  }

  /**
   * Resuelve la página interna /player/{token} al embed real
   * (`window.location.href = 'https://...'` inyectado por su JS).
   */
  private async resolvePlayerPage(playerUrl: string): Promise<string> {
    if (!playerUrl.includes("/player/")) return playerUrl;
    const html = await this.fetchHtml(playerUrl, 8000);
    if (!html) return playerUrl;
    const m = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
    return m ? m[1] : playerUrl;
  }

  public async analyze(
    input: string,
    explicitType?: "auto" | "catalog" | "detail" | "stream"
  ): Promise<UniversalAnalysisResult> {
    const cleanUrl = input.trim();

    let path = "";
    try {
      path = new URL(cleanUrl).pathname.toLowerCase();
    } catch {
      // No es URL -> tratar como búsqueda
      const catalogItems = await this.search(cleanUrl);
      return {
        page_type: "catalog",
        content_type: "series",
        title: `Resultados para "${cleanUrl}" - TioPlus`,
        description: `Búsqueda de ${catalogItems.length} títulos en TioPlus para "${cleanUrl}"`,
        poster_url: catalogItems[0]?.image_url || null,
        banner_url: catalogItems[0]?.image_url || null,
        rating: 0,
        year: new Date().getFullYear(),
        status: "Publicado",
        genres: [],
        source_domain: "tioplus.app",
        episodes: [],
        catalog_items: catalogItems,
      };
    }

    // 1. Modo catálogo: Home, listados, géneros o petición explícita
    const isCatalogPath =
      path === "/" ||
      /^\/(peliculas|series|animes|doramas)(\/.*)?$/.test(path) ||
      path.startsWith("/genero/") ||
      path.startsWith("/year/");
    if (explicitType === "catalog" || isCatalogPath) {
      const catalogUrl = this.resolveRelativeUrl(cleanUrl, BASE_URL);
      const html = await this.fetchHtml(catalogUrl, 10000);
      const catalogItems = html ? this.extractCatalogItems(html) : [];

      return {
        page_type: "catalog",
        content_type: "series",
        title: `Catálogo - TioPlus (${path === "/" ? "Inicio" : path})`,
        description: `Catálogo de TioPlus (${catalogItems.length} títulos)`,
        poster_url: catalogItems[0]?.image_url || null,
        banner_url: catalogItems[0]?.image_url || null,
        rating: 0,
        year: new Date().getFullYear(),
        status: "Publicado",
        genres: [],
        source_domain: "tioplus.app",
        episodes: [],
        catalog_items: catalogItems,
      };
    }

    // 2. Modo detalle (película, serie, anime o episodio)
    const html = await this.fetchHtml(cleanUrl, 10000);
    if (!html) {
      return {
        page_type: "detail",
        content_type: this.kindFromUrl(cleanUrl) || "series",
        title: "Contenido TioPlus",
        description: "No se pudo cargar la página",
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: new Date().getFullYear(),
        status: "Desconocido",
        genres: [],
        source_domain: "tioplus.app",
        episodes: [],
        catalog_items: [],
      };
    }

    const metadata = this.extractMetadata(html, cleanUrl);
    const kind = this.kindFromUrl(cleanUrl) || metadata.content_type;
    const episodes = kind === "movie" ? [] : this.extractEpisodes(html, cleanUrl);

    let detectedStreams: string[] | undefined;
    if (!explicitType || explicitType === "stream" || explicitType === "auto") {
      try {
        const streamResult = await this.extractStream(cleanUrl);
        detectedStreams = streamResult.all_available_streams;
      } catch {}
    }

    return {
      page_type: "detail",
      content_type: kind,
      title: metadata.title,
      description: metadata.description,
      poster_url: metadata.poster_url || null,
      banner_url: metadata.banner_url || null,
      rating: metadata.rating,
      year: metadata.year,
      status: "Publicado",
      genres: metadata.genres,
      source_domain: "tioplus.app",
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
   * Extrae streams de una página de episodio/película:
   * 1. decodeDataVideos -> candidatos (embeds directos o páginas /player/)
   * 2. Resolver páginas /player/ al embed real
   * 3. EmbedResolvers.resolve sobre cada embed
   * 4. MediaValidator.validateUrls y priorización de .m3u8/.mp4 directos
   */
  public async extractStream(
    targetUrl: string
  ): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const cleanUrl = targetUrl.trim();
    const html = await this.fetchHtml(cleanUrl, 12000);

    if (!html) {
      return { stream_url: cleanUrl, all_available_streams: [cleanUrl] };
    }

    const $ = cheerio.load(html);
    const title =
      $("h1.slugh1").first().text().trim() ||
      cleanTitle($('meta[property="og:title"]').attr("content") || "") ||
      $("title").text().trim() ||
      undefined;

    const candidates = this.decodeDataVideos(html);
    if (candidates.length === 0) {
      const genericStreams = await super.extractStream(cleanUrl);
      return { ...genericStreams, title };
    }

    // Descartar players SPA no reproducibles antes de gastar red en resolverlos
    const playableCandidates = candidates.filter((c) => !this.isUnplayablePlayerUrl(c));
    if (playableCandidates.length === 0) {
      const genericStreams = await super.extractStream(cleanUrl);
      return { ...genericStreams, title };
    }

    // Resolver páginas /player/ a embeds reales (en paralelo)
    const embedUrls = await Promise.all(
      playableCandidates.map(async (c) => {
        try {
          return c.includes("/player/") ? await this.resolvePlayerPage(c) : c;
        } catch {
          return c;
        }
      })
    );

    // Resolver cada embed con EmbedResolvers (en paralelo)
    const resolutions = await Promise.all(
      embedUrls.map(async (embedUrl) => {
        if (this.isUnplayablePlayerUrl(embedUrl)) return null;
        try {
          const resolved = await EmbedResolvers.resolve(embedUrl);
          return { embedUrl, resolved: resolved || embedUrl };
        } catch {
          return { embedUrl, resolved: embedUrl };
        }
      })
    );

    const usableResolutions = resolutions.filter(
      (r): r is { embedUrl: string; resolved: string } => r !== null
    );

    const all_available_streams: string[] = [];
    for (const { embedUrl, resolved } of usableResolutions) {
      if (!all_available_streams.includes(resolved)) all_available_streams.push(resolved);
      if (resolved !== embedUrl && !all_available_streams.includes(embedUrl)) {
        all_available_streams.push(embedUrl);
      }
    }

    const validated = await MediaValidator.validateUrls(all_available_streams);
    // El validador aprueba cualquier HTML 200 (incluye players SPA que no reproducen),
    // por eso el filtrado de hosts no reproducibles se aplica también al final.
    const finalBase =
      validated.length > 0
        ? validated.filter((s) => !this.isUnplayablePlayerUrl(s))
        : all_available_streams.filter((s) => !this.isUnplayablePlayerUrl(s));

    const direct = finalBase.filter((s) => /\.(m3u8|mp4|webm)(\?|$)/i.test(s));
    const ordered =
      direct.length > 0
        ? [...direct, ...finalBase.filter((s) => !direct.includes(s))]
        : finalBase;

    return {
      stream_url: ordered[0] || cleanUrl,
      all_available_streams: ordered.length > 0 ? ordered : [cleanUrl],
      title,
    };
  }

  /** kind según span.typeItem del sitio: clases movie | anime | (serie) */
  private kindFromTypeItem(typeClass: string): ContentKind | null {
    if (typeClass.includes("movie")) return "movie";
    if (typeClass.includes("anime")) return "anime";
    if (typeClass.includes("serie") || typeClass.includes("dorama")) return "series";
    return null;
  }

  /** kind según la ruta: /pelicula/ -> movie, /anime/ -> anime, /serie/ -> series */
  private kindFromUrl(url: string): ContentKind | null {
    const lower = url.toLowerCase();
    if (lower.includes("/pelicula")) return "movie";
    if (lower.includes("/anime")) return "anime";
    if (lower.includes("/serie") || lower.includes("/dorama")) return "series";
    return null;
  }

  /** Construye URL de episodio respetando el prefijo /serie/ o /anime/ de la página actual */
  private buildEpisodeUrl(baseUrl: string, season: number, episode: number): string {
    try {
      const parts = new URL(baseUrl).pathname.split("/").filter(Boolean);
      const prefix = ["serie", "anime"].includes(parts[0]) ? parts[0] : "serie";
      const slug = parts[1] || "";
      return `${BASE_URL}/${prefix}/${slug}/season/${season}/episode/${episode}`;
    } catch {
      return `${BASE_URL}/serie/unknown/season/${season}/episode/${episode}`;
    }
  }

  private titleFromSlug(url: string): string {
    try {
      const parts = new URL(url).pathname.split("/").filter(Boolean);
      const slug = parts[1] || parts[0] || "titulo";
      return slug
        .replace(/-/g, " ")
        .replace(/\b\w/g, (l) => l.toUpperCase())
        .trim();
    } catch {
      return "TioPlus";
    }
  }
}
