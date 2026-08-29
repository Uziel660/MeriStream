import * as cheerio from "cheerio";
import { BaseScraperAdapter } from "../BaseAdapter";
import { UniversalAnalysisResult, ContentKind, ExtractedEpisode, ExtractedCatalogItem } from "../../types";
import { EmbedResolvers, isSupportedServer } from "../../resolvers";
import { MediaValidator } from "../../validator";
import { probeStream, orderStreamsByHealth } from "../hostHealth";
import { cleanDescription } from "../../utils/textCleaner";

const BASE_URL = "https://wwv.veranimes.net";

const DEAD_OR_BLOCKED_HOST_PATTERNS = [
  /cfglobalcdn\.com/i,
  /yourupload\.com/i,
  /streamtape\./i,
  /dsvplay\.com/i,
  /savefiles\.com/i,
  /d-s\.io/i,
  /vidcache\.net/i,
  /my\.mail\.ru/i,
  /v\.tioanime\.com/i,
];

const isDeadOrBlocked = (url: string) =>
  DEAD_OR_BLOCKED_HOST_PATTERNS.some((p) => p.test(url));

/**
 * Adaptador para VerAnimes (wwv.veranimes.net)
 *
 * - Catálogo/Búsqueda: selector `<article>` (búsqueda en /animes?buscar=...)
 * - Detalles: metadatos OpenGraph (og:title, og:image, og:description)
 * - Episodios: la lista se genera por JS (`var eps = [...]` + atributo data-sl);
 *   se reconstruye server-side sin navegador.
 * - Video: los botones de servidores son `<li>`/`<button>` con URL ofuscada.
 *   El sitio real usa el atributo `encrypt` (URL en hexadecimal); este adaptador
 *   también acepta `data-video` (URL plana o Base64). Los botones se obtienen
 *   vía POST a `{origin}/process` con `acc=opt&i=<data-encrypt>` y las URLs
 *   resultantes se resuelven con EmbedResolvers y se validan con MediaValidator.
 */
export class VerAnimesAdapter extends BaseScraperAdapter {
  readonly id = "veranimes";
  readonly name = "VerAnimes";
  readonly supportedDomains = ["veranimes.net", "wwv.veranimes.net", "www.veranimes.net"];

  canHandle(url: string): boolean {
    return url.toLowerCase().includes("veranimes.net");
  }

  /**
   * Búsqueda de animes en VerAnimes (/animes?buscar=...)
   */
  public async search(query: string): Promise<ExtractedCatalogItem[]> {
    const searchUrl = `${BASE_URL}/animes?buscar=${encodeURIComponent(query.trim())}`;
    const html = await this.fetchHtml(searchUrl, 10000);
    if (!html) return [];
    return this.extractCatalogItems(html);
  }

  /**
   * Extrae items de catálogo desde el Home, listado /animes o resultados de búsqueda.
   * Estructura real verificada:
   *   <article class="li">
   *     <figure class="i"><a href="..."><img data-src="...cdn/img/{anime|portada}/x.webp" src="placeholder"></a><span>TV</span></figure>
   *     <h3 class="h"><a href="..." title="...">Título</a></h3>
   *   </article>
   */
  public extractCatalogItems(html: string): ExtractedCatalogItem[] {
    const $ = cheerio.load(html);
    const items: ExtractedCatalogItem[] = [];
    const seen = new Set<string>();

    $("article").each((_, el) => {
      const $art = $(el);
      const $link = $art.find("a[href*='/anime/']").first();
      const href = ($link.attr("href") || $art.find("a[href]").first().attr("href") || "").trim();
      if (!href || seen.has(href)) return;
      seen.add(href);

      const url = this.resolveRelativeUrl(href, BASE_URL);

      // Imagen: priorizar data-src (lazy load), ignorar placeholders del CDN propio
      const $img = $art.find("img").first();
      const rawImg = $img.attr("data-src") || $img.attr("src") || "";
      const isPlaceholder = /cdn\/img\/(anime|episode)\.png/i.test(rawImg);
      const imageUrl =
        rawImg && !isPlaceholder ? this.resolveRelativeUrl(rawImg, BASE_URL) : null;

      // Título: texto del h3.h > a, alt de la imagen o atributo title del enlace
      const title =
        $art.find("h3.h a").text().trim() ||
        ($img.attr("alt") || "").trim() ||
        ($link.attr("title") || "").trim() ||
        this.titleFromUrl(url);

      items.push({
        title,
        url,
        image_url: imageUrl,
        kind: "anime",
      });
    });

    return items;
  }

  /**
   * Metadatos de una página de detalle usando OpenGraph.
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
    content_type: ContentKind;
  } {
    const $ = cheerio.load(html);

    const ogTitle = $('meta[property="og:title"]').attr("content") || "";
    const h1Title = $("h1").first().text().trim();
    
    let rawTitle = ogTitle || h1Title || "";
    // Limpiar ruido típico de VerAnimes: "Ver X Anime Online Gratis", "Ver X Sub Español", etc.
    rawTitle = rawTitle
      .replace(/^Ver\s+/i, "")
      .replace(/\s*[-–—|•]\s*VerAnime[s]?\s*$/i, "")
      .replace(/\s*(?:Anime\s+)?(?:Sub\s+Español|Audio\s+Latino|Latino|Castellano)?\s*(?:Online)?\s*(?:Gratis)?\s*(?:en\s+HD)?\s*$/i, "")
      .replace(/\s*\((?:TV|Movie|OVA|ONA)\)\s*/gi, " ")
      .trim();

    const title = rawTitle || h1Title || "Anime VerAnimes";

    const ogImage = $('meta[property="og:image"]').attr("content");
    const poster_url = ogImage ? this.resolveRelativeUrl(ogImage, url) : undefined;

    const rawDescription = $('meta[property="og:description"]').attr("content")?.trim() || "";
    const description = cleanDescription(rawDescription, title);

    const genres: string[] = [];
    $("ul.gn li a, .gn a").each((_, el) => {
      const genre = $(el).text().trim();
      if (genre && !genres.includes(genre)) genres.push(genre);
    });

    const yearMatch =
      html.match(/Año[\s:]*(\d{4})/i)?.[1] ||
      html.match(/\b(19[5-9]\d|20[0-2]\d)\b/)?.[0] ||
      url.match(/-(19\d{2}|20[0-2]\d)(?:\/|$|\?)/i)?.[1]; // fallback: año en el slug
    const year = yearMatch ? parseInt(yearMatch, 10) : 0;

    return {
      title,
      description,
      poster_url,
      banner_url: undefined, // Dejar que el enriquecedor TMDB/AniList asigne un backdrop 16:9 real
      genres,
      year,
      content_type: "anime",
    };
  }

  /**
   * Lista de episodios de una página de detalle.
   *
   * Caso principal (página /anime/{slug}): los enlaces los construye el JS con
   * `var eps = ["N","N-1",...]` + atributo `data-sl`. Se reconstruyen como
   * {base}/ver/{sl}-{ep}.
   * Fallback: enlaces estáticos `a[href*="/ver/"]` (Home / listados).
   */
  public extractEpisodes(html: string, baseUrl: string): ExtractedEpisode[] {
    const episodes: ExtractedEpisode[] = [];
    const seen = new Set<string>();
    const base = baseUrl || BASE_URL;

    // 1. Reconstrucción desde el array JS + slug
    const epsMatch = html.match(/var\s+eps\s*=\s*(\[[^\]]*\])/);
    const slMatch = html.match(/data-sl="([^"]+)"/);
    if (epsMatch && slMatch) {
      try {
        const eps: string[] = JSON.parse(epsMatch[1]);
        const slug = slMatch[1];
        for (const epn of eps) {
          const number = parseInt(epn, 10);
          if (!Number.isFinite(number)) continue;
          const url = this.resolveRelativeUrl(`/ver/${slug}-${epn}`, base);
          if (seen.has(url)) continue;
          seen.add(url);
          episodes.push({ number, title: `Episodio ${epn}`, url, server_name: "VerAnimes" });
        }
      } catch {}
    }

    // 2. Fallback: enlaces estáticos a páginas de episodio
    if (episodes.length === 0) {
      const $ = cheerio.load(html);
      $("a[href*='/ver/']").each((_, el) => {
        const href = $(el).attr("href");
        if (!href || href.includes("process")) return;
        const fullUrl = this.resolveRelativeUrl(href, base);
        if (seen.has(fullUrl)) return;
        seen.add(fullUrl);

        const numberMatch = fullUrl.match(/-([0-9]+)(?:\?.*)?$/) || fullUrl.match(/(\d+)\s*$/);
        const number = numberMatch ? parseInt(numberMatch[1], 10) : episodes.length + 1;
        const linkText = $(el).text().replace(/\s+/g, " ").trim();
        const capMatch = linkText.match(/[Ee]pisodio\s*(\d+)/);
        const title = capMatch ? `Episodio ${capMatch[1]}` : linkText || `Episodio ${number}`;
        episodes.push({ number, title, url: fullUrl, server_name: "VerAnimes" });
      });
    }

    return episodes.sort((a, b) => a.number - b.number);
  }

  /**
   * Localiza botones de selección de servidor (<li> o <button>) con URL de video
   * ofuscada y devuelve las URLs de iframe/embed decodificadas.
   *
   * Atributos soportados (en orden):
   * - `data-video`: URL plana (https://..., //...) o Base64
   * - `encrypt`:    URL codificada en hexadecimal (mecanismo real de VerAnimes,
   *                 equivalente JS: hex2a)
   */
  public decodeDataVideoButtons(html: string): string[] {
    if (!html || !html.includes("<")) return [];
    const $ = cheerio.load(html);
    const urls: string[] = [];

    $("[data-video], [encrypt]").each((_, el) => {
      const $el = $(el);
      const raw = ($el.attr("data-video") || $el.attr("encrypt") || "").trim();
      if (!raw) return;

      const decoded = this.decodeServerValue(raw);
      if (decoded && !urls.includes(decoded)) urls.push(decoded);
    });

    return urls;
  }

  /**
   * Decodifica el valor de un botón de servidor:
   * URL plana → tal cual; hexadecimal → ASCII; Base64 → UTF-8.
   */
  private decodeServerValue(value: string): string | null {
    const v = value.trim();
    if (!v) return null;

    if (/^https?:\/\//i.test(v)) return v;
    if (v.startsWith("//")) return `https:${v}`;

    // Hexadecimal (hex2a del sitio): longitud par y solo caracteres hex
    if (/^[0-9a-fA-F]+$/.test(v) && v.length >= 20 && v.length % 2 === 0) {
      const ascii = this.hexToAscii(v);
      if (/^https?:\/\//i.test(ascii)) return ascii;
    }

    // Base64
    if (this.isBase64(v)) {
      try {
        const decoded = Buffer.from(v, "base64").toString("utf-8").trim();
        if (/^https?:\/\//i.test(decoded)) return decoded;
      } catch {}
    }

    return null;
  }

  /**
   * Equivalente server-side de la función hex2a() del sitio.
   */
  private hexToAscii(hex: string): string {
    let str = "";
    for (let i = 0; i < hex.length; i += 2) {
      str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return str;
  }

  /**
   * Obtiene los botones de servidores reales de una página de episodio.
   *
   * Flujo verificado contra el sitio:
   * 1. La página trae <ul class="opt" data-encrypt="{id}"> vacío.
   * 2. El JS hace $.post('./process', {acc:'opt', i:id}); por el <base href>
   *    del sitio, './process' resuelve al ORIGEN: POST {origin}/process.
   * 3. La respuesta es el HTML de los <li encrypt="hex"> que este método
   *    decodifica con decodeDataVideoButtons().
   */
  public async resolveServerButtons(episodeUrl: string): Promise<string[]> {
    const cleanUrl = episodeUrl.trim();
    const html = await this.fetchHtml(cleanUrl, 12000);
    if (!html || this.isErrorPage(html)) return [];

    // Botones inline si existieran (mocks u otras variantes del sitio)
    const inlineUrls = this.decodeDataVideoButtons(html);

    const encMatch =
      html.match(/<ul[^>]+class="opt"[^>]+data-encrypt="([^"]+)"/i) ||
      html.match(/data-encrypt="([^"]+)"/i);

    let remoteUrls: string[] = [];
    if (encMatch) {
      const optionsHtml = await this.postProcessEndpoint(cleanUrl, encMatch[1]);
      if (optionsHtml) {
        remoteUrls = this.decodeDataVideoButtons(optionsHtml);
      }
    }

    const all = [...remoteUrls, ...inlineUrls];
    return Array.from(new Set(all));
  }

  /**
   * POST al endpoint /process del origen (equivalente del $.post del sitio).
   */
  private async postProcessEndpoint(pageUrl: string, encryptId: string): Promise<string | null> {
    try {
      const origin = new URL(pageUrl).origin;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(`${origin}/process`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          ...{ "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          Referer: pageUrl,
          Origin: origin,
        },
        body: new URLSearchParams({ acc: "opt", i: encryptId }).toString(),
      });
      clearTimeout(timer);

      if (!res.ok) return null;
      const text = await res.text();
      // El sitio responde con HTML de <li>; un 404 devolvería una página completa
      if (!text || text.includes("<!DOCTYPE")) return null;
      return text;
    } catch {
      return null;
    }
  }

  public async analyze(
    input: string,
    explicitType?: "auto" | "catalog" | "detail" | "stream"
  ): Promise<UniversalAnalysisResult> {
    const cleanUrl = input.trim();

    let path = "/";
    try {
      path = new URL(cleanUrl).pathname.toLowerCase();
    } catch {}

    // 1. Modo catálogo: Home o listado /animes
    if (explicitType === "catalog" || path === "/" || path.startsWith("/animes")) {
      const fetchUrl = path === "/" ? BASE_URL : cleanUrl;
      const html = await this.fetchHtml(fetchUrl, 10000);
      if (!html) throw new Error(`FETCH_FAILED: ${fetchUrl}`);
      const catalogItems = this.extractCatalogItems(html);

      return {
        page_type: "catalog",
        content_type: "anime",
        title: "Catálogo de Animes - VerAnimes",
        description: `Catálogo de animes en VerAnimes (${catalogItems.length} títulos)`,
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: 0,
        status: "Publicado",
        genres: [],
        source_domain: "wwv.veranimes.net",
        episodes: [],
        catalog_items: catalogItems,
      };
    }

    // 2. Páginas de episodio (/ver/...)
    if (path.startsWith("/ver/")) {
      const html = await this.fetchHtml(cleanUrl, 12000);
      if (html && this.isErrorPage(html)) {
        return {
          page_type: "direct_stream",
          content_type: "anime",
          title: "Contenido no disponible - VerAnimes",
          description: `La página ${cleanUrl} no existe en VerAnimes (error 404 del sitio).`,
          poster_url: null,
          banner_url: null,
          rating: 0,
          year: 0,
          status: "No encontrado",
          genres: [],
          source_domain: "wwv.veranimes.net",
          episodes: [],
          catalog_items: [],
        };
      }
      const metadata = html
        ? this.extractMetadata(html, cleanUrl)
        : { title: "Episodio VerAnimes", description: "", poster_url: undefined, banner_url: undefined, genres: [] as string[], year: 0, content_type: "anime" as ContentKind };

      let detectedStreams: string[] | undefined;
      if (!explicitType || explicitType === "stream" || explicitType === "auto") {
        try {
          const streamResult = await this.extractStream(cleanUrl);
          detectedStreams = streamResult.all_available_streams.length > 0 ? streamResult.all_available_streams : undefined;
        } catch {}
      }

      return {
        page_type: "direct_stream",
        content_type: "anime",
        title: metadata.title,
        description: metadata.description,
        poster_url: metadata.poster_url || null,
        banner_url: metadata.banner_url || null,
        rating: 7.0,
        year: metadata.year,
        status: "Publicado",
        genres: metadata.genres,
        source_domain: "wwv.veranimes.net",
        detected_streams: detectedStreams,
        episodes: [],
        catalog_items: [],
      };
    }

    // 3. Modo detalle (/anime/...)
    const html = await this.fetchHtml(cleanUrl, 10000);
    if (!html || this.isErrorPage(html)) {
      return {
        page_type: "detail",
        content_type: "anime",
        title: "Anime VerAnimes",
        description: html
          ? "El contenido solicitado no existe en VerAnimes (error 404 del sitio)."
          : "No se pudo cargar la página",
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: 0,
        status: "No encontrado",
        genres: [],
        source_domain: "wwv.veranimes.net",
        episodes: [],
        catalog_items: [],
      };
    }

    const metadata = this.extractMetadata(html, cleanUrl);
    const episodes = this.extractEpisodes(html, cleanUrl);

    let detectedStreams: string[] | undefined;
    if (!explicitType || explicitType === "stream" || explicitType === "auto") {
      try {
        const first = episodes[0];
        if (first) {
          const streamResult = await this.extractStream(first.url);
          detectedStreams = streamResult.all_available_streams;
        }
      } catch {}
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
      source_domain: "wwv.veranimes.net",
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
   * 1. Obtiene los botones de servidores (POST /process + decodificación hex/data-video).
   * 2. Resuelve cada iframe con EmbedResolvers para obtener .m3u8/.mp4 directos.
   * 3. Valida con MediaValidator y prioriza streams directos.
   */
  public async extractStream(targetUrl: string): Promise<{
    stream_url: string;
    all_available_streams: string[];
    title?: string;
  }> {
    const cleanUrl = targetUrl.trim();
    const html = await this.fetchHtml(cleanUrl, 12000);

    const is404 = !!html && this.isErrorPage(html);
    const title = html && !is404
      ? (html.match(/property="og:title"\s+content="([^"]+)"/i)?.[1] || "")
          .replace(/\s*[-–—]\s*VerAnime\s*$/i, "")
          .trim() || undefined
      : undefined;

    if (is404) {
      return { stream_url: "", all_available_streams: [], title };
    }

    let iframeUrls: string[] = [];
    if (html) {
      // Botones inline si existieran (mocks u otras variantes del sitio)
      iframeUrls = this.decodeDataVideoButtons(html);

      const encMatch =
        html.match(/<ul[^>]+class="opt"[^>]+data-encrypt="([^"]+)"/i) ||
        html.match(/data-encrypt="([^"]+)"/i);
      if (encMatch) {
        const optionsHtml = await this.postProcessEndpoint(cleanUrl, encMatch[1]);
        if (optionsHtml) {
          for (const url of this.decodeDataVideoButtons(optionsHtml)) {
            if (!iframeUrls.includes(url)) iframeUrls.push(url);
          }
        }
      }
    }

    if (iframeUrls.length === 0) {
      const genericStreams = await super.extractStream(cleanUrl);
      return { ...genericStreams, title };
    }

    // Priorizar servidores soportados (resolvers.ts); ignorar ofuscados/raros.
    const alive = iframeUrls.filter((u) => !isDeadOrBlocked(u));
    const supported = alive.filter((u) => isSupportedServer(u));

    let candidates: string[] = supported;
    let deobfuscated: string[] = [];

    if (supported.length === 0) {
      // Único disponible es un servidor ofuscado: intentar desofuscar bysesukior.
      for (const u of alive) {
        try {
          const d = await EmbedResolvers.resolve(u);
          if (d && /\.(m3u8|mp4|webm)(\?|$)/i.test(d) && !deobfuscated.includes(d)) {
            deobfuscated.push(d);
          }
        } catch {}
      }
    }

    const finalCandidates = candidates.length > 0 ? candidates : deobfuscated;

    if (finalCandidates.length === 0) {
      // Sin servidores soportados ni desofuscables: no alimentar el frontend con
      // iframes no renderizables. Dejar que el caller pruebe alternativas.
      return { stream_url: "", all_available_streams: [], title };
    }

    // Resolver todos los iframes en paralelo
    const resolutions = await Promise.all(
      finalCandidates.map(async (iframeUrl) => {
        try {
          return { iframeUrl, resolved: await EmbedResolvers.resolve(iframeUrl) };
        } catch {
          return { iframeUrl, resolved: "" };
        }
      })
    );

    const all_available_streams: string[] = [];
    const directStreams: string[] = [];

    for (const { iframeUrl, resolved } of resolutions) {
      const finalUrl = resolved && !isDeadOrBlocked(resolved) ? resolved : "";
      if (!finalUrl) continue;

      const isDirectMedia = /\.(m3u8|mp4|webm)(\?|$)/i.test(finalUrl);
      if (isDirectMedia) {
        if (!directStreams.includes(finalUrl)) directStreams.push(finalUrl);
        if (!all_available_streams.includes(finalUrl)) all_available_streams.push(finalUrl);
      } else if (isSupportedServer(finalUrl) || isSupportedServer(iframeUrl)) {
        // Embed jugable por el frontend (mega, ok.ru, etc.) — no un ofuscado raro.
        if (!all_available_streams.includes(finalUrl)) all_available_streams.push(finalUrl);
      }
      // else: servidor ofuscado no soportado -> ignorado
    }

    // Sondeo de salud de streams directos: los CDNs con hotlink-protection pueden
    // estar caídos o lentos (ej. a3.mp4upload.com:183 tarda 10-36s en handshake TLS).
    // Sin sondeo, un MP4 muerto encabeza la lista y el player falla antes del failover.
    let healthyDirects: string[] = [];
    if (directStreams.length > 0) {
      healthyDirects = await this.probeAndOrderDirectStreams(directStreams);
    }
    const failedDirects = directStreams.filter((d) => !healthyDirects.includes(d));

    const isUnreliableEmbed = (u: string) => /hqq\.|waaw|cvary\.org|divxplayer/i.test(u);
    const embedStreams = all_available_streams.filter((s) => !directStreams.includes(s));
    const reliableEmbeds = embedStreams.filter((s) => !isUnreliableEmbed(s));
    const lowPriorityEmbeds = embedStreams.filter((s) => isUnreliableEmbed(s));
    const sortedEmbeds = [...reliableEmbeds, ...lowPriorityEmbeds];

    const ordered = [...healthyDirects, ...sortedEmbeds, ...failedDirects];

    // Validación final con MediaValidator
    const validStreams = await MediaValidator.validateUrls(ordered);
    const finalStreams = validStreams.length > 0 ? validStreams : ordered;

    return {
      stream_url: finalStreams[0] || cleanUrl,
      all_available_streams: finalStreams.length > 0 ? finalStreams : [cleanUrl],
      title,
    };
  }

  /**
   * Sonda de salud de URLs de media directo (.m3u8/.mp4), delegada al módulo
   * global hostHealth (headers del proxy según hostProfiles + caché negativa).
   * Devuelve las sanas primero (orden original) y descarta las que no
   * responden a tiempo.
   */
  private async probeAndOrderDirectStreams(urls: string[]): Promise<string[]> {
    if (urls.length === 0) return [];
    const results = await Promise.all(
      urls.map((url) => probeStream(url, { playerReferer: "https://wwv.veranimes.net/", timeoutMs: 4000 }))
    );
    return results.filter((r) => r.ok).map((r) => r.url);
  }

  /**
   * Detecta páginas de error del sitio (slug inexistente): VerAnimes devuelve
   * un HTTP 404 con ~37KB de HTML válido cuyo <title>/og:title es "Error 404".
   * BaseAdapter.fetchHtml devuelve ese cuerpo por diseño (workaround LaMovie),
   * así que hay que filtrarlo explícitamente antes de extraer metadatos.
   */
  private isErrorPage(html: string): boolean {
    if (!html) return false;
    const $ = cheerio.load(html);
    const pageTitle = ($("title").first().text() || "").trim();
    const ogTitle = $('meta[property="og:title"]').attr("content") || "";
    const combined = `${pageTitle} ${ogTitle}`.toLowerCase();
    return (
      /\b404\b/.test(combined) ||
      combined.includes("no encontrado") ||
      combined.includes("not found") ||
      combined.startsWith("error")
    );
  }

  private titleFromUrl(url: string): string {
    const match = url.match(/\/(?:anime|ver)\/([^/?#]+)/);
    if (!match) return "Anime VerAnimes";
    return match[1]
      .replace(/-\d+$/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase())
      .trim();
  }
}
